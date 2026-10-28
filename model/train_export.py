"""
Train the MUC02 credit pre-screener exactly as in the team notebook and export it
to app/model.json so the web app can score applications in the browser.

Usage (from the repo root):
    python model/train_export.py
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, confusion_matrix, precision_score, recall_score, roc_auc_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "MUC02_Credit_PreScreening_Dataset.csv"
OUT = ROOT / "app" / "model.json"

THRESHOLD = 0.90
MONTHLY_APPS, MINUTES_PER_REVIEW = 3000, 25

# ---------- clean (same decisions as Step 5.1) ----------
df = pd.read_csv(DATA)
df.loc[df["monthly_income"] > 600_000, "monthly_income"] /= 12
emp_median = df.groupby("employment_type")["monthly_income"].median()
df["monthly_income"] = df["monthly_income"].fillna(df["employment_type"].map(emp_median))

# ---------- features (Step 5.3) ----------
df["foir"] = (df["existing_emi"] + df["proposed_emi"]) / df["monthly_income"]
df["loan_to_income"] = df["loan_amount"] / (df["monthly_income"] * 12)
df["is_ntc"] = df["credit_score"].isna().astype(int)
score_median = float(df["credit_score"].median())

NUM = ["credit_score", "is_ntc", "foir", "loan_to_income", "delinquencies_24m",
       "num_active_loans", "years_in_current_job", "age", "tenure_months", "city_tier"]
CAT = ["employment_type", "loan_purpose"]

X = df[NUM + CAT].copy()
X["credit_score"] = X["credit_score"].fillna(score_median)
y = (df["decision"] == "Declined").astype(int)

X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.2, stratify=y, random_state=42)
model = Pipeline([
    ("prep", ColumnTransformer([("num", StandardScaler(), NUM),
                                ("cat", OneHotEncoder(handle_unknown="ignore"), CAT)])),
    ("logreg", LogisticRegression(max_iter=1000)),
]).fit(X_tr, y_tr)

proba = model.predict_proba(X_te)[:, 1]
pred = (proba >= 0.5).astype(int)
tn, fp, fn, tp = confusion_matrix(y_te, pred).ravel()

prep = model.named_steps["prep"]
scaler = prep.named_transformers_["num"]
enc = prep.named_transformers_["cat"]
lr = model.named_steps["logreg"]
coefs = lr.coef_[0]

# ---------- export ----------
spec = {
    "version": "muc02-logreg-1",
    "threshold": THRESHOLD,
    "monthly_apps": MONTHLY_APPS,
    "minutes_per_review": MINUTES_PER_REVIEW,
    "credit_score_fill": score_median,
    "income_fill_by_employment": {k: float(v) for k, v in emp_median.items()},
    "numeric": [{"name": n, "mean": float(m), "scale": float(s), "coef": float(c)}
                for n, m, s, c in zip(NUM, scaler.mean_, scaler.scale_, coefs[:len(NUM)])],
    "categorical": [],
    "intercept": float(lr.intercept_[0]),
    "metrics": {
        "test_size": int(len(y_te)),
        "accuracy": accuracy_score(y_te, pred), "roc_auc": roc_auc_score(y_te, proba),
        "precision_declined": precision_score(y_te, pred), "recall_declined": recall_score(y_te, pred),
        "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
    },
    # Test-set predictions so the app can recompute the threshold trade-off live
    "test": {
        "p": [round(float(v), 9) for v in proba],
        "y": [int(v) for v in y_te],
        "ntc": [int(v) for v in X_te["is_ntc"]],
        "female": [int(v) for v in (df.loc[X_te.index, "gender"] == "Female")],
    },
}
i = len(NUM)
for feat, cats in zip(CAT, enc.categories_):
    spec["categorical"].append({"name": feat, "levels": {str(c): float(coefs[i + j]) for j, c in enumerate(cats)}})
    i += len(cats)

OUT.write_text(json.dumps(spec, separators=(",", ":")))
print(f"Wrote {OUT}  accuracy={spec['metrics']['accuracy']:.3f}  auc={spec['metrics']['roc_auc']:.3f}  FP={fp}")

# Parity fixture: a few test rows with sklearn's probability, used to check the JS scorer
RAW = ["application_id", "age", "employment_type", "years_in_current_job", "monthly_income", "existing_emi",
       "credit_score", "num_active_loans", "delinquencies_24m", "loan_purpose", "loan_amount",
       "tenure_months", "proposed_emi", "city_tier"]
fixture = df.loc[X_te.index[:300], RAW].copy()
fixture["sk_proba"] = proba[:300]
fixture.to_json(ROOT / "model" / "parity_fixture.json", orient="records")
