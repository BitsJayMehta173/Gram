"""
Sanity-check model #1 from the dataset README: predict `eligible` (the hard
agronomic gate) from the scenario + enterprise features.

Why this is the right first model to train, not just any model:
  `eligible` is a fully DETERMINISTIC rule in the source code (isEligible in
  backend/src/services/scoring.js) — it isn't measuring anything noisy or
  subjective. That makes it the ideal pipeline sanity check: if a model
  *can't* learn this near-perfectly, the bug is in the data pipeline (feature
  encoding, train/test split, etc.), not in the difficulty of the task. If it
  scores near 100%, that's not "the model is smart" — it's confirmation the
  plumbing works, clearing the way to trust the harder regression/ranking
  tasks trained on the same pipeline later.

We deliberately train TWO models, not one:
  - Logistic Regression: a linear baseline. Eligibility is a set of AND'd
    categorical-membership + threshold rules per enterprise — not linearly
    separable in the raw one-hot feature space without interaction terms, so
    this is expected to underperform. Included on purpose, as a contrast.
  - Random Forest: a tree ensemble, which can represent exactly this kind of
    nested conjunctive rule. Expected to score at or near 100%.
Comparing them is itself part of the sanity check: it confirms the *task* is
learnable at all (by ruling out "no model can learn this, the labels must be
noise/broken") while showing that model choice matters for rule-shaped data.
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

CATEGORICAL_FEATURES = ["zone", "soil_type", "water_source", "season", "enterprise_id"]
NUMERIC_FEATURES = ["area_acre", "budget_npr", "budget_is_set"]
TARGET = "eligible"


def load_data() -> pd.DataFrame:
    df = pd.read_csv(DATA_PATH)
    # budget_npr is blank (NaN) for the "unconstrained" sweep tier. Eligibility
    # in the source rule (isEligible) doesn't depend on budget at all — kept
    # in as a feature anyway so the model has to *learn* that irrelevance
    # itself, and we can verify it via feature_importances_ below, rather
    # than assuming it and hiding a potential bug.
    df["budget_is_set"] = df["budget_npr"].notna().astype(int)
    df["budget_npr"] = df["budget_npr"].fillna(0)
    return df


def build_pipeline(model) -> Pipeline:
    preprocessor = ColumnTransformer(
        transformers=[
            ("cat", OneHotEncoder(handle_unknown="ignore"), CATEGORICAL_FEATURES),
            ("num", "passthrough", NUMERIC_FEATURES),
        ]
    )
    return Pipeline(steps=[("preprocess", preprocessor), ("model", model)])


def evaluate(name: str, pipeline: Pipeline, X_test, y_test) -> dict:
    y_pred = pipeline.predict(X_test)
    report = classification_report(y_test, y_pred, target_names=["ineligible", "eligible"], output_dict=True)
    cm = confusion_matrix(y_test, y_pred)

    print(f"\n=== {name} ===")
    print(classification_report(y_test, y_pred, target_names=["ineligible", "eligible"]))
    print("Confusion matrix [[TN, FP], [FN, TP]]:")
    print(cm)

    fig, ax = plt.subplots(figsize=(5, 4))
    ConfusionMatrixDisplay(cm, display_labels=["ineligible", "eligible"]).plot(ax=ax, colorbar=False)
    ax.set_title(f"{name} — eligibility classifier")
    fig.tight_layout()
    fig_path = REPORTS_DIR / f"confusion_matrix_{name.lower().replace(' ', '_')}.png"
    fig.savefig(fig_path, dpi=150)
    plt.close(fig)

    return {"report": report, "confusion_matrix": cm.tolist(), "confusion_matrix_plot": str(fig_path)}


def main():
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)

    df = load_data()
    X = df[CATEGORICAL_FEATURES + NUMERIC_FEATURES]
    y = df[TARGET]

    print(f"Loaded {len(df)} rows. Class balance: {y.value_counts(normalize=True).to_dict()}")

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.25, random_state=42, stratify=y)
    print(f"Train: {len(X_train)} rows | Test: {len(X_test)} rows")

    results = {}

    logreg = build_pipeline(LogisticRegression(max_iter=1000))
    logreg.fit(X_train, y_train)
    results["logistic_regression"] = evaluate("Logistic Regression", logreg, X_test, y_test)

    rf = build_pipeline(RandomForestClassifier(n_estimators=200, max_depth=None, random_state=42, n_jobs=-1))
    rf.fit(X_train, y_train)
    results["random_forest"] = evaluate("Random Forest", rf, X_test, y_test)

    # Feature importances (from the Random Forest, on the one-hot-expanded
    # feature names) — this is the concrete evidence for whether the model
    # correctly learned that budget is irrelevant to eligibility.
    feature_names = rf.named_steps["preprocess"].get_feature_names_out()
    importances = rf.named_steps["model"].feature_importances_
    importance_pairs = sorted(zip(feature_names, importances), key=lambda p: -p[1])
    print("\nTop 15 feature importances (Random Forest):")
    for fname, imp in importance_pairs[:15]:
        print(f"  {fname:35s} {imp:.4f}")
    budget_importance = sum(imp for fname, imp in importance_pairs if fname.startswith("num__budget"))
    print(f"\nCombined importance of budget-related features: {budget_importance:.4f} (expect ~0)")

    joblib.dump(rf, MODELS_DIR / "eligibility_classifier_rf.joblib")
    joblib.dump(logreg, MODELS_DIR / "eligibility_classifier_logreg.joblib")

    summary = {
        "rows": len(df),
        "train_rows": len(X_train),
        "test_rows": len(X_test),
        "class_balance": y.value_counts(normalize=True).to_dict(),
        "logistic_regression_accuracy": results["logistic_regression"]["report"]["accuracy"],
        "random_forest_accuracy": results["random_forest"]["report"]["accuracy"],
        "budget_feature_importance": budget_importance,
        "top_feature_importances": [{"feature": f, "importance": float(i)} for f, i in importance_pairs[:15]],
    }
    with open(REPORTS_DIR / "eligibility_classifier_summary.json", "w") as f:
        json.dump(summary, f, indent=2)

    print(f"\nSaved models to {MODELS_DIR}")
    print(f"Saved reports to {REPORTS_DIR}")


if __name__ == "__main__":
    main()
