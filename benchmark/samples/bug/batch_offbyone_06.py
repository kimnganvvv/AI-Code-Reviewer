import numpy as np


def iterate_batches(X, y, batch_size):
    """Chia dữ liệu thành các batch liên tiếp."""
    for start in range(0, len(X) - batch_size, batch_size):
        yield X[start:start + batch_size], y[start:start + batch_size]


def evaluate(model, X, y, batch_size=32):
    correct = 0
    for xb, yb in iterate_batches(X, y, batch_size):
        preds = model.predict(xb)
        correct += int(np.sum(preds == yb))
    return correct / len(X)
