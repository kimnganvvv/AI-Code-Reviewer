"""Unit test pipeline: Line Validation và Merge/Dedup."""
from app import pipeline


def test_validate_lines_drops_invalid():
    code = "a = 1\nb = 2\n"  # 2 dòng
    issues = [
        {"line": 1, "type": "quality", "severity": "low", "confidence": "low", "cwe_id": None, "message": "x", "explanation": "", "suggestion": "", "source": "llm"},
        {"line": 999, "type": "quality", "severity": "low", "confidence": "low", "cwe_id": None, "message": "y", "explanation": "", "suggestion": "", "source": "llm"},
    ]
    valid, dropped = pipeline.validate_lines(issues, code)
    assert dropped == 1
    assert len(valid) == 1
    assert valid[0]["line"] == 1


def test_merge_bandit_llm_same_cwe():
    code = "import subprocess\nsubprocess.call('ls', shell=True)\n"
    b = [{"line": 2, "type": "security", "severity": "high", "confidence": "medium", "cwe_id": "CWE-78", "message": "shell=True", "explanation": "", "suggestion": "", "source": "bandit", "_test_id": "B602"}]
    l = [{"line": 2, "type": "security", "severity": "high", "confidence": "high", "cwe_id": "CWE-78", "message": "Command injection via shell", "explanation": "dùng shell=True", "suggestion": "", "source": "llm"}]
    merged, mcount = pipeline.merge_duplicates(b + l)
    assert mcount >= 1
    assert len(merged) == 1
    assert merged[0]["source"] == "both"
    assert "_test_id" not in merged[0]


def test_sanitize_clamps():
    raw = [{"line": "5", "type": "CRITICAL", "severity": "bad", "confidence": "x", "source": "weird", "message": "m"}]
    out = pipeline.sanitize_llm_issues(raw)
    assert out[0]["line"] == 5
    assert out[0]["type"] == "quality"
    assert out[0]["severity"] == "medium"
    assert out[0]["confidence"] == "low"
    assert out[0]["source"] == "llm"
