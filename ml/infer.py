"""
Inference script: given one real plot, rank all 11 enterprises using the
three trained models.

Two design decisions worth stating up front:

1. The hard eligibility gate uses the REAL rule (isEligible() from
   backend/src/services/scoring.js, reimplemented here from enterprises.json
   -- same source file the backend reads), not the trained eligibility
   classifier. The classifier hit 100% on held-out grid points, but it's a
   tree ensemble trained on only 10 discrete area_acre values
   (AREA_ACRE_VALUES in generate_dataset.js) -- for an off-grid input (e.g.
   1.23 acres, never swept during training) near a minAreaAcre boundary, a
   tree's behavior isn't guaranteed the way an exact rule's is. Given the
   standing requirement that this system must never suggest an
   agronomically-impossible crop, the exact rule is strictly the safer
   choice for the gate itself. The trained classifier's prediction is still
   shown, as `ml_eligibility_confidence` -- a diagnostic that lets you see
   whether the ML approximation agrees with ground truth on real, off-grid
   inputs, which the train/test split never actually tested (every grid
   point in that split was something the model trained on similar
   neighbors of).

2. Profit and ranking DO use the trained Random Forest models, as asked.
   Worth being honest about what that currently buys: every one of these
   models was distilled from the SAME deterministic rule engine (there is
   no independent real-world outcome data yet -- see Phase 5 of the
   roadmap), so today the rule engine is strictly at least as accurate as
   its own distillation. What this script actually validates is
   generalization: area_acre/budget_npr here can be ANY value, not just the
   10/5 swept grid points the models were evaluated on during training. The
   ML models become genuinely necessary once real farmer-outcome data
   eventually replaces the rule-engine-generated dataset.

The eligibility gate takes precedence over the ranking score when sorting
results -- the same precedence generateAllocationPlans()/getRecommendations()
use in scoring.js -- so an ineligible enterprise can never outrank an
eligible one just because the ranking model scored it highly.
"""

import argparse
import json as jsonlib
from datetime import datetime
from pathlib import Path

import joblib
import pandas as pd

ROOT = Path(__file__).resolve().parent
MODELS_DIR = ROOT / "models"
ENTERPRISES_PATH = ROOT.parent / "backend" / "src" / "data" / "enterprises.json"

ZONES = ["terai", "hills", "high-hills"]
SOIL_TYPES = ["alluvial", "loamy", "clayey", "sandy-loam"]
WATER_SOURCES = ["irrigated", "rainfed"]
SEASONS = ["kharif", "rabi", "zaid"]


def default_season() -> str:
    # Mirrors currentSeason() in backend/src/services/season.js exactly.
    month = datetime.now().month
    if 6 <= month <= 10:
        return "kharif"
    if 3 <= month <= 5:
        return "zaid"
    return "rabi"


def load_enterprises() -> list:
    with open(ENTERPRISES_PATH, encoding="utf-8") as f:
        data = jsonlib.load(f)
    return data["enterprises"]


def load_models() -> dict:
    return {
        "eligibility": joblib.load(MODELS_DIR / "eligibility_classifier_rf.joblib"),
        "profit": joblib.load(MODELS_DIR / "profit_regressor_rf.joblib"),
        "ranking": joblib.load(MODELS_DIR / "best_choice_ranking_rf.joblib"),
    }


def is_eligible(enterprise: dict, area_acre: float, zone: str, season: str, soil_type: str, water_source: str) -> bool:
    if zone not in enterprise["zones"]:
        return False
    if season not in enterprise["seasons"]:
        return False
    if soil_type not in enterprise["soilTypes"] and "any" not in enterprise["soilTypes"]:
        return False
    if water_source not in enterprise["waterSources"] and "any" not in enterprise["waterSources"]:
        return False
    if area_acre < enterprise["minAreaAcre"]:
        return False
    return True


def eligibility_reason(enterprise: dict, area_acre: float, zone: str, season: str, soil_type: str, water_source: str):
    if zone not in enterprise["zones"]:
        return f"not grown in the {zone} zone (needs {'/'.join(enterprise['zones'])})"
    if season not in enterprise["seasons"]:
        return f"not a {season}-season enterprise (needs {'/'.join(enterprise['seasons'])})"
    if soil_type not in enterprise["soilTypes"] and "any" not in enterprise["soilTypes"]:
        return f"needs {'/'.join(enterprise['soilTypes'])} soil, not {soil_type}"
    if water_source not in enterprise["waterSources"] and "any" not in enterprise["waterSources"]:
        return f"needs {'/'.join(enterprise['waterSources'])} water, not {water_source}"
    if area_acre < enterprise["minAreaAcre"]:
        return f"needs at least {enterprise['minAreaAcre']} acre, plot is only {area_acre}"
    return None


def build_feature_row(enterprise: dict, ctx: dict) -> dict:
    econ = enterprise["economics"]
    risk = enterprise["risk"]
    return {
        "zone": ctx["zone"],
        "soil_type": ctx["soil_type"],
        "water_source": ctx["water_source"],
        "season": ctx["season"],
        "enterprise_id": enterprise["id"],
        "scales_with": enterprise["scalesWith"],
        "area_acre": ctx["area_acre"],
        "budget_npr": ctx["budget_npr"] if ctx["budget_npr"] is not None else 0,
        "budget_is_set": 1 if ctx["budget_npr"] is not None else 0,
        "min_area_acre": enterprise["minAreaAcre"],
        "duration_days": enterprise["durationDays"],
        "base_cost_per_unit": econ["costPerUnit"],
        "base_yield_per_unit": econ["yieldPerUnit"],
        "price_min": econ["priceMin"],
        "price_max": econ["priceMax"],
        "price_volatility": risk["priceVolatility"],
        "water_dependency": risk["waterDependency"],
        "capital_lock_in": risk["capitalLockIn"],
    }


def predict(enterprises: list, ctx: dict, models: dict) -> list:
    rows = [build_feature_row(e, ctx) for e in enterprises]
    # One shared feature frame for all three pipelines -- each ColumnTransformer
    # selects only the columns it was fit on and ignores the rest, so the
    # eligibility classifier's narrower feature set (no scales_with / static
    # economics) is satisfied by this same frame as the other two models'.
    X = pd.DataFrame(rows)

    ml_eligible_proba = models["eligibility"].predict_proba(X)[:, 1]
    profit_pred = models["profit"].predict(X)
    best_proba = models["ranking"].predict_proba(X)[:, 1]

    results = []
    for i, e in enumerate(enterprises):
        args = (e, ctx["area_acre"], ctx["zone"], ctx["season"], ctx["soil_type"], ctx["water_source"])
        real_eligible = is_eligible(*args)
        results.append(
            {
                "id": e["id"],
                "name": e["name"],
                "category": e["category"],
                "eligible": real_eligible,
                "ineligible_reason": None if real_eligible else eligibility_reason(*args),
                "ml_eligibility_confidence": round(float(ml_eligible_proba[i]), 3),
                # The profit regressor trained ONLY on eligible==1 rows (see
                # train_profit_regression.py) -- predicting for an ineligible
                # candidate would be extrapolating outside its training
                # distribution, so it's suppressed rather than shown as a
                # real number.
                "predicted_profit_npr": round(float(profit_pred[i])) if real_eligible else None,
                "best_choice_probability": round(float(best_proba[i]), 3),
            }
        )

    results.sort(key=lambda r: (not r["eligible"], -r["best_choice_probability"]))
    return results


def print_report(ctx: dict, results: list) -> None:
    budget_label = f"NPR {ctx['budget_npr']:,.0f}" if ctx["budget_npr"] is not None else "unconstrained"
    print(
        f"\nPlot: {ctx['area_acre']} acre | Zone: {ctx['zone']} | Soil: {ctx['soil_type']} | "
        f"Water: {ctx['water_source']} | Season: {ctx['season']} | Budget: {budget_label}\n"
    )

    header = f"{'#':<3} {'Enterprise':<22} {'Eligible':<9} {'Pred. Profit (NPR)':>20} {'P(best)':>9} {'ML-elig-conf':>13}"
    print(header)
    print("-" * len(header))
    for i, r in enumerate(results, start=1):
        elig_label = "Yes" if r["eligible"] else "No"
        profit_label = f"{r['predicted_profit_npr']:,}" if r["predicted_profit_npr"] is not None else "n/a"
        print(
            f"{i:<3} {r['name']:<22} {elig_label:<9} {profit_label:>20} "
            f"{r['best_choice_probability']:>9.3f} {r['ml_eligibility_confidence']:>13.3f}"
        )
        if not r["eligible"]:
            print(f"      -> {r['ineligible_reason']}")

    top = results[0]
    if top["eligible"]:
        print(
            f"\nTop pick: {top['name']} -- predicted profit NPR {top['predicted_profit_npr']:,}, "
            f"model confidence {top['best_choice_probability']:.2f}"
        )
    else:
        print("\nNo eligible enterprise found for this plot.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rank enterprises for a plot using the trained ML models.")
    parser.add_argument("--area-acre", type=float, required=True)
    parser.add_argument("--zone", choices=ZONES, required=True)
    parser.add_argument("--soil-type", choices=SOIL_TYPES, required=True)
    parser.add_argument("--water-source", choices=WATER_SOURCES, required=True)
    parser.add_argument("--season", choices=SEASONS, default=None, help="defaults to the current calendar season")
    parser.add_argument("--budget", type=float, default=None, help="NPR, omit for unconstrained")
    parser.add_argument("--json", action="store_true", help="print JSON only, no table")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.area_acre <= 0:
        raise SystemExit("--area-acre must be positive")
    if args.budget is not None and args.budget <= 0:
        raise SystemExit("--budget must be positive if given")

    ctx = {
        "area_acre": args.area_acre,
        "zone": args.zone,
        "soil_type": args.soil_type,
        "water_source": args.water_source,
        "season": args.season or default_season(),
        "budget_npr": args.budget,
    }

    enterprises = load_enterprises()
    models = load_models()
    results = predict(enterprises, ctx, models)

    if args.json:
        print(jsonlib.dumps({"context": ctx, "results": results}, indent=2))
    else:
        print_report(ctx, results)


if __name__ == "__main__":
    main()
