import numpy as np


def preprocess_train(df):
    df = df.copy()
    df["total"] = df["price"] * df["quantity"]
    df["is_weekend"] = (df["weekday"] >= 5).astype(int)
    df["log_total"] = np.log1p(df["total"])
    df["hour_sin"] = np.sin(2 * np.pi * df["hour"] / 24)
    df["hour_cos"] = np.cos(2 * np.pi * df["hour"] / 24)
    df["spend_per_item"] = df["total"] / df["quantity"].clip(lower=1)
    df = df[df["total"] < df["total"].quantile(0.99)]
    return df.drop(columns=["price", "quantity"])


def preprocess_test(df):
    df = df.copy()
    df["total"] = df["price"] * df["quantity"]
    df["is_weekend"] = (df["weekday"] >= 5).astype(int)
    df["log_total"] = np.log1p(df["total"])
    df["hour_sin"] = np.sin(2 * np.pi * df["hour"] / 24)
    df["hour_cos"] = np.cos(2 * np.pi * df["hour"] / 24)
    df["spend_per_item"] = df["total"] / df["quantity"].clip(lower=1)
    return df.drop(columns=["price", "quantity"])
