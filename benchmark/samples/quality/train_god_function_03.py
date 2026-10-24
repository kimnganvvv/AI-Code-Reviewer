import json

import joblib
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, f1_score
from sklearn.model_selection import train_test_split


def run_pipeline(csv_path, out_dir):
    df = pd.read_csv(csv_path)
    df = df.dropna(subset=["label"])
    for col in df.columns:
        if df[col].dtype == "object" and col != "label":
            df[col] = df[col].astype("category").cat.codes
        elif df[col].isnull().sum() > 0:
            df[col] = df[col].fillna(0)
    df["total_spend"] = df["price"] * df["quantity"]
    df["is_weekend"] = (df["weekday"] >= 5).astype(int)
    df["spend_per_item"] = df["total_spend"] / df["quantity"].replace(0, 1)

    X = df.drop(columns=["label"])
    y = df["label"]
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42
    )
    model = RandomForestClassifier(n_estimators=200, max_depth=12, random_state=42)
    model.fit(X_train, y_train)

    preds = model.predict(X_test)
    acc = accuracy_score(y_test, preds)
    f1 = f1_score(y_test, preds, average="macro")
    if acc < 0.85:
        print("Cảnh báo: độ chính xác thấp", acc)

    importances = dict(zip(X.columns, model.feature_importances_))
    top = sorted(importances.items(), key=lambda kv: kv[1], reverse=True)[:5]
    joblib.dump(model, f"{out_dir}/model.joblib")
    with open(f"{out_dir}/report.json", "w", encoding="utf-8") as f:
        json.dump({"accuracy": acc, "f1": f1, "top_features": top}, f, ensure_ascii=False)
    return model
