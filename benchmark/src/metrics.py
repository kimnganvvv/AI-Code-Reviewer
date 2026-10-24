"""Các công thức chỉ số. Không phụ thuộc mạng hay LLM."""
from __future__ import annotations


def safe_div(a: float, b: float) -> float:
    return a / b if b else 0.0


def prf(tp: int, fp: int, fn: int) -> dict:
    precision = safe_div(tp, tp + fp)
    recall = safe_div(tp, tp + fn)
    f1 = safe_div(2 * precision * recall, precision + recall)
    return {"precision": precision, "recall": recall, "f1": f1}


def file_fpr(flagged_clean_files: int, total_clean_files: int) -> float:
    """Tỷ lệ file sạch bị báo ít nhất một lỗi."""
    return safe_div(flagged_clean_files, total_clean_files)


def percentile(values, q: float) -> float:
    """Phân vị q (0-100), nội suy tuyến tính."""
    data = sorted(values)
    if not data:
        return 0.0
    if len(data) == 1:
        return float(data[0])
    pos = (len(data) - 1) * q / 100
    low = int(pos)
    high = min(low + 1, len(data) - 1)
    return float(data[low] + (data[high] - data[low]) * (pos - low))


def latency_summary(values) -> dict:
    values = list(values)
    return {
        "n": len(values),
        "median": percentile(values, 50),
        "p95": percentile(values, 95),
        "mean": safe_div(sum(values), len(values)),
    }
