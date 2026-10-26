import pytest
from src.metrics import file_fpr, latency_summary, percentile, prf, safe_div


def test_precision_recall_f1_basic():
    m = prf(tp=1, fp=1, fn=1)
    assert m["precision"] == 0.5 and m["recall"] == 0.5 and m["f1"] == 0.5


def test_prf_known_values():
    m = prf(tp=12, fp=10, fn=13)
    assert m["precision"] == pytest.approx(12 / 22)
    assert m["recall"] == pytest.approx(12 / 25)


def test_zero_division_is_zero():
    assert prf(0, 0, 0) == {"precision": 0.0, "recall": 0.0, "f1": 0.0}
    assert safe_div(1, 0) == 0.0


def test_file_fpr():
    assert file_fpr(3, 5) == pytest.approx(0.6)
    assert file_fpr(0, 0) == 0.0


def test_percentile_and_latency_summary():
    assert percentile([1, 2, 3, 4, 5], 50) == 3
    assert percentile([10], 95) == 10
    assert percentile([], 50) == 0.0
    s = latency_summary([1.0, 2.0, 3.0, 4.0])
    assert s["n"] == 4 and s["median"] == 2.5 and s["mean"] == 2.5
