"""
Sanity-check model #2 from the dataset README: predict `profit_avg_npr` from
scenario + enterprise static features, restricted to `eligible == 1` rows.

Why this is a meaningful next step, not just "task 1 again with a number
instead of a label":
  Tracing economicsForUnits() + resolveUnitsForFullArea() in
  backend/src/services/scoring.js shows profit_avg_npr is STILL fully
  deterministic (no noise) — but the shape is harder than eligibility's
  flat AND-of-conditions rule:
    profit_avg_npr = units * (yieldPerUnit * priceAvg - costPerUnit)
  where `units` is itself:
    - for crops (scales_with == "area"):     units ~= area_acre (or capped)
    - for livestock (scales_with == "budget"): units = a FLOOR() step
      function of area_acre/min_area_acre AND budget_npr/cost_per_unit
  That's a multiplicative interaction (area x per-unit margin) plus a
  piecewise/step function for livestock — neither is representable by plain
  Linear Regression without hand-built interaction terms, so the
  Linear-vs-RandomForest gap here is itself evidence of *why* tree ensembles
  suit this problem, not just a leaderboard number.

A second, mirror-image sanity check to task 1's "budget importance ~0" one:
  Eligibility depends on zone/soil_type/water_source/season/area_acre and NOT
  budget. Profit is the opposite: once you're already in the eligible subset,
  profit depends on enterprise_id/area_acre/budget_npr/static economics and
  NOT zone/soil_type/water_source/season (those already did their job
  filtering to "eligible"). So this script groups feature importances into
  "driver" vs "control" sets and checks the control sum is ~0 — the same
  verification spirit as task 1, applied to a different, checkable claim
  about the ground-truth formula.
"""

import json
from pathlib import Path

import joblib
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestRegressor
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, r2_score, root_mean_squared_error
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder

ROOT = Path(__file__).resolve().parent
DATA_PATH = ROOT.parent / "backend" / "data" / "training" / "land_recommendation_dataset.csv"
MODELS_DIR = ROOT / "models"
REPORTS_DIR = ROOT / "reports"

CATEGORICAL_FEATURES = ["zone", "soil_type", "water_source", "season", "enterprise_id", "scales_with"]
NUMERIC_FEATURES = [
    "area_acre",
    "budget_npr",
    "budget_is_set",
    "min_area_acre",
    "duration_days",
    "base_cost_per_unit",
    "base_yield_per_unit",
    "price_min",
    "price_max",
    "price_volatility",
    "water_dependency",
    "capital_lock_in",
]
TARGET = "profit_avg_npr"

# Features the ground-truth formula actually uses to compute profit_avg_npr.
DRIVER_FEATURES = {
    "enterprise_id",
    "scales_with",
    "area_acre",
    "budget_npr",
    "budget_is_set",
    "min_area_acre",
    "base_cost_per_unit",
    "base_yield_per_unit",
    "price_min",
    "price_max",
}
# Features that affect eligibility or risk_score, but never appear in the
# profit_avg_npr formula itself — expected to carry ~0 importance here.
CONTROL_FEATURES = {
    "zone",
    "soil_type",
    "water_source",
    "season",
    "duration_days",
    "price_volatility",
    "water_dependency",
    "capital_lock_in",
}


def load_data() -> pd.DataFrame:
    df = pd.read_csv(DATA_PATH)
    df = df[df["eligible"] == 1].copy()
    df["budget_is_set"] = df["budget_npr"].notna().astype(int)
    df["budget_npr"] = df["budget_npr"].fillna(0)
    df[TARGET] = pd.to_numeric(df[TARGET], errors="coerce")
    assert df[TARGET].notna().all(), "eligible==1 rows should never have a blank profit_avg_npr"
    return df


def build_pipeline(model) -> Pipeline:
    preprocessor = ColumnTransformer(
        transformers=[
            ("cat", OneHotEncoder(handle_unknown="ignore"), CATEGORICAL_FEATURES),
            ("num", "passthrough", NUMERIC_FEATURES),
        ]
    )
    return Pipeline(steps=[("preprocess", preprocessor), ("model", model)])


def raw_feature_of(encoded_name: str) -> str:
    prefix, body = encoded_name.split("__", 1)
    if prefix == "num":
        return body
    for col in CATEGORICAL_FEATURES:
        if body.startswith(col + "_"):
            return col
    return body


def evaluate(name: str, pipeline: Pipeline, X_test, y_test) -> dict:
    y_pred = pipeline.predict(X_test)
    r2 = r2_score(y_test, y_pred)
    mae = mean_absolute_error(y_test, y_pred)
    rmse = root_mean_squared_error(y_test, y_pred)

    print(f"\n=== {name} ===")
    print(f"R^2:  {r2:.4f}")
    print(f"MAE:  NPR {mae:,.0f}")
    print(f"RMSE: NPR {rmse:,.0f}")

    fig, ax = plt.subplots(figsize=(5, 5))
    ax.scatter(y_test, y_pred, s=6, alpha=0.25, color="#06c167", linewidths=0)
    lims = [min(y_test.min(), y_pred.min()), max(y_test.max(), y_pred.max())]
    ax.plot(lims, lims, "--", color="#000000", linewidth=1, label="perfect prediction")
    ax.set_xlabel("Actual profit_avg_npr")
    ax.set_ylabel("Predicted profit_avg_npr")
    ax.set_title(f"{name} — profit regression (R²={r2:.3f})")
    ax.legend()
    fig.tight_layout()
    fig_path = REPORTS_DIR / f"scatter_{name.lower().replace(' ', '_')}.png"
    fig.savefig(fig_path, dpi=150)
    plt.close(fig)

    return {"r2": r2, "mae": mae, "rmse": rmse, "scatter_plot": str(fig_path)}


def main():
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)

    df = load_data()
    X = df[CATEGORICAL_FEATURES + NUMERIC_FEATURES]
    y = df[TARGET]

    print(f"Loaded {len(df)} eligible rows (of {pd.read_csv(DATA_PATH).shape[0]} total).")
    print(f"profit_avg_npr range: NPR {y.min():,.0f} to NPR {y.max():,.0f}, mean NPR {y.mean():,.0f}")

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.25, random_state=42)
    print(f"Train: {len(X_train)} rows | Test: {len(X_test)} rows")

    results = {}

    linreg = build_pipeline(LinearRegression())
    linreg.fit(X_train, y_train)
    results["linear_regression"] = evaluate("Linear Regression", linreg, X_test, y_test)

    rf = build_pipeline(RandomForestRegressor(n_estimators=300, random_state=42, n_jobs=-1))
    rf.fit(X_train, y_train)
    results["random_forest"] = evaluate("Random Forest", rf, X_test, y_test)

    # Group one-hot-expanded importances back to their raw feature, then into
    # driver vs control sets -- the concrete evidence for whether the model
    # learned the right causal structure (see module docstring).
    feature_names = rf.named_steps["preprocess"].get_feature_names_out()
    importances = rf.named_steps["model"].feature_importances_
    grouped: dict[str, float] = {}
    for fname, imp in zip(feature_names, importances):
        raw = raw_feature_of(fname)
        grouped[raw] = grouped.get(raw, 0.0) + float(imp)

    ranked = sorted(grouped.items(), key=lambda p: -p[1])
    print("\nFeature importances grouped by raw (pre-one-hot) feature:")
    for raw, imp in ranked:
        tag = "driver" if raw in DRIVER_FEATURES else "control"
        print(f"  {raw:22s} {imp:.4f}  ({tag})")

    driver_sum = sum(imp for raw, imp in grouped.items() if raw in DRIVER_FEATURES)
    control_sum = sum(imp for raw, imp in grouped.items() if raw in CONTROL_FEATURES)
    print(f"\nDriver-feature importance sum:  {driver_sum:.4f} (expect close to 1)")
    print(f"Control-feature importance sum: {control_sum:.4f} (expect ~0 -- zone/soil/water/season/etc")
    print("                                  never appear in the profit_avg_npr formula)")

    joblib.dump(rf, MODELS_DIR / "profit_regressor_rf.joblib")
    joblib.dump(linreg, MODELS_DIR / "profit_regressor_linear.joblib")

    summary = {
        "rows": len(df),
        "train_rows": len(X_train),
        "test_rows": len(X_test),
        "target_stats": {"min": float(y.min()), "max": float(y.max()), "mean": float(y.mean())},
        "linear_regression": {k: v for k, v in results["linear_regression"].items() if k != "scatter_plot"},
        "random_forest": {k: v for k, v in results["random_forest"].items() if k != "scatter_plot"},
        "driver_importance_sum": driver_sum,
        "control_importance_sum": control_sum,
        "feature_importances_grouped": [{"feature": r, "importance": i, "tag": "driver" if r in DRIVER_FEATURES else "control"} for r, i in ranked],
    }
    with open(REPORTS_DIR / "profit_regression_summary.json", "w") as f:
        json.dump(summary, f, indent=2)

    print(f"\nSaved models to {MODELS_DIR}")
    print(f"Saved reports to {REPORTS_DIR}")


if __name__ == "__main__":
    main()
