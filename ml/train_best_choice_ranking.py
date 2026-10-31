"""
Sanity-check model #3 from the dataset README: predict `is_best_for_scenario`
-- the single top-ranked enterprise per scenario_id group -- the task closest
to "what should this farmer actually plant here."

The one design decision that matters most in this script: which columns are
allowed as features.

  is_best_for_scenario is LITERALLY argmax(combined_score) among eligible
  (and budget-affordable, when a budget is set) candidates within a
  scenario_id group (see backend/scripts/generate_dataset.js). If
  combined_score -- or any of its inputs (agronomic_score, economic_score,
  risk_pipeline_score, roi_percent, risk_score, affordable, eligible, ...) --
  were included as a feature, this "model" would degenerate into a column
  lookup, not a prediction: it would score 100% while having learned
  nothing. So this script uses ONLY the raw scenario inputs + enterprise
  static attributes (the exact same feature set as
  train_profit_regression.py) -- no computed score/label column from the
  dataset is allowed in. That reframes the task honestly as: can one learned
  model distill the ENTIRE multi-stage rule engine (eligibility gate ->
  economics -> three scoring pipelines -> weighted combine -> per-scenario
  argmax) from just the inputs a real plot would actually have? That's a
  meaningfully harder and more useful test than tasks 1 and 2, which were
  each handed one *stage* of the pipeline in isolation.

Second design decision: the train/test split is done by scenario_id, not by
row. is_best_for_scenario only makes sense as a *within-group* comparison
(this enterprise vs. the ~10 other candidates for the SAME plot) -- a plain
row-level random split could put some of a scenario's candidates in train and
others in test, making that comparison impossible to evaluate honestly.
Splitting whole scenario_id groups keeps every scenario entirely on one side.

Because of that, this script reports two views of performance:
  - the standard row-level classification_report/confusion matrix (is any
    given row "best or not", treated independently) -- useful, but not the
    real question.
  - grouped top-1 / top-3 accuracy: for each TEST scenario, rank its ~11
    candidate rows by predicted P(best) and check whether the rule engine's
    actual pick lands in the model's top-1 (exact match) or top-3 (a
    practically-useful shortlist). This is the metric that actually answers
    "if a farmer used this model instead of the rule engine, how often would
    it point at the same crop."
"""

import json
from pathlib import Path

import joblib
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import ConfusionMatrixDisplay, classification_report, confusion_matrix
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder

ROOT = Path(__file__).resolve().parent
DATA_PATH = ROOT.parent / "backend" / "data" / "training" / "land_recommendation_dataset.csv"
MODELS_DIR = ROOT / "models"
REPORTS_DIR = ROOT / "reports"

# Identical feature set to train_profit_regression.py, deliberately -- see
# module docstring. No computed score/label column is allowed in.
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
TARGET = "is_best_for_scenario"
GROUP_COL = "scenario_id"


def load_data() -> pd.DataFrame:
    df = pd.read_csv(DATA_PATH)
    df["budget_is_set"] = df["budget_npr"].notna().astype(int)
    df["budget_npr"] = df["budget_npr"].fillna(0)
    counts = df.groupby(GROUP_COL)[TARGET].sum()
    assert (counts == 1).all(), "expected exactly one is_best_for_scenario=1 row per scenario"
    return df


def split_by_scenario(df: pd.DataFrame, test_size=0.25, random_state=42):
    scenario_ids = df[GROUP_COL].unique()
    train_ids, test_ids = train_test_split(scenario_ids, test_size=test_size, random_state=random_state)
    train_df = df[df[GROUP_COL].isin(train_ids)].copy()
    test_df = df[df[GROUP_COL].isin(test_ids)].copy()
    return train_df, test_df


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


def grouped_topk_accuracy(test_df: pd.DataFrame, pred_proba, k: int) -> float:
    scored = test_df.copy()
    scored["pred_proba"] = pred_proba
    correct = 0
    total = 0
    for _, group in scored.groupby(GROUP_COL):
        total += 1
        ranked = group.sort_values("pred_proba", ascending=False)
        true_best = group.index[group[TARGET] == 1][0]
        if true_best in ranked.index[:k]:
            correct += 1
    return correct / total


def evaluate(name: str, pipeline: Pipeline, X_test, y_test, test_df: pd.DataFrame) -> dict:
    y_pred = pipeline.predict(X_test)
    pred_proba = pipeline.predict_proba(X_test)[:, 1]

    report = classification_report(y_test, y_pred, target_names=["not_best", "best"], output_dict=True)
    cm = confusion_matrix(y_test, y_pred)
    top1 = grouped_topk_accuracy(test_df, pred_proba, k=1)
    top3 = grouped_topk_accuracy(test_df, pred_proba, k=3)

    print(f"\n=== {name} ===")
    print(classification_report(y_test, y_pred, target_names=["not_best", "best"]))
    print("Confusion matrix [[TN, FP], [FN, TP]]:")
    print(cm)
    print(f"Grouped top-1 accuracy (model's #1 pick matches rule engine's pick): {top1:.4f}")
    print(f"Grouped top-3 accuracy (rule engine's pick is in model's top 3):     {top3:.4f}")

    fig, ax = plt.subplots(figsize=(5, 4))
    ConfusionMatrixDisplay(cm, display_labels=["not_best", "best"]).plot(ax=ax, colorbar=False)
    ax.set_title(f"{name} — best-choice classifier (row-level)")
    fig.tight_layout()
    fig_path = REPORTS_DIR / f"confusion_matrix_ranking_{name.lower().replace(' ', '_')}.png"
    fig.savefig(fig_path, dpi=150)
    plt.close(fig)

    return {
        "report": report,
        "confusion_matrix": cm.tolist(),
        "top1_group_accuracy": top1,
        "top3_group_accuracy": top3,
        "confusion_matrix_plot": str(fig_path),
    }


def main():
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)

    df = load_data()
    print(f"Loaded {len(df)} rows across {df[GROUP_COL].nunique()} scenarios.")
    print(f"Class balance: {df[TARGET].value_counts(normalize=True).to_dict()}")

    train_df, test_df = split_by_scenario(df)
    print(
        f"Train: {len(train_df)} rows ({train_df[GROUP_COL].nunique()} scenarios) | "
        f"Test: {len(test_df)} rows ({test_df[GROUP_COL].nunique()} scenarios)"
    )

    X_train, y_train = train_df[CATEGORICAL_FEATURES + NUMERIC_FEATURES], train_df[TARGET]
    X_test, y_test = test_df[CATEGORICAL_FEATURES + NUMERIC_FEATURES], test_df[TARGET]

    results = {}

    logreg = build_pipeline(LogisticRegression(max_iter=1000))
    logreg.fit(X_train, y_train)
    results["logistic_regression"] = evaluate("Logistic Regression", logreg, X_test, y_test, test_df)

    rf = build_pipeline(RandomForestClassifier(n_estimators=300, random_state=42, n_jobs=-1))
    rf.fit(X_train, y_train)
    results["random_forest"] = evaluate("Random Forest", rf, X_test, y_test, test_df)

    feature_names = rf.named_steps["preprocess"].get_feature_names_out()
    importances = rf.named_steps["model"].feature_importances_
    grouped: dict[str, float] = {}
    for fname, imp in zip(feature_names, importances):
        raw = raw_feature_of(fname)
        grouped[raw] = grouped.get(raw, 0.0) + float(imp)
    ranked = sorted(grouped.items(), key=lambda p: -p[1])
    print("\nFeature importances grouped by raw (pre-one-hot) feature:")
    for raw, imp in ranked:
        print(f"  {raw:22s} {imp:.4f}")

    joblib.dump(rf, MODELS_DIR / "best_choice_ranking_rf.joblib")
    joblib.dump(logreg, MODELS_DIR / "best_choice_ranking_logreg.joblib")

    summary = {
        "rows": len(df),
        "scenarios": int(df[GROUP_COL].nunique()),
        "train_rows": len(train_df),
        "test_rows": len(test_df),
        "train_scenarios": int(train_df[GROUP_COL].nunique()),
        "test_scenarios": int(test_df[GROUP_COL].nunique()),
        "class_balance": df[TARGET].value_counts(normalize=True).to_dict(),
        "logistic_regression": {k: v for k, v in results["logistic_regression"].items() if k != "confusion_matrix_plot"},
        "random_forest": {k: v for k, v in results["random_forest"].items() if k != "confusion_matrix_plot"},
        "feature_importances_grouped": [{"feature": r, "importance": i} for r, i in ranked],
    }
    with open(REPORTS_DIR / "best_choice_ranking_summary.json", "w") as f:
        json.dump(summary, f, indent=2)

    print(f"\nSaved models to {MODELS_DIR}")
    print(f"Saved reports to {REPORTS_DIR}")


if __name__ == "__main__":
    main()
