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


BANDIT_ISSUE = {
    "line": 2, "type": "security", "severity": "high", "confidence": "high",
    "cwe_id": "CWE-78", "message": "shell=True", "explanation": "",
    "suggestion": "", "source": "bandit", "_test_id": "B602",
}
LLM_ISSUE = {
    "line": 2, "type": "security", "severity": "high", "confidence": "high",
    "cwe_id": "CWE-78", "message": "Command injection", "explanation": "",
    "suggestion": "", "source": "llm",
}


def test_mode_bandit_skips_llm(monkeypatch):
    code = "import subprocess\nsubprocess.call('ls', shell=True)\n"
    monkeypatch.setattr(pipeline, "run_bandit", lambda _code: [dict(BANDIT_ISSUE)])
    monkeypatch.setattr(pipeline, "llm_is_configured", lambda: True)

    def _boom(*_args, **_kwargs):
        raise AssertionError("mode=bandit không được gọi LLM")

    monkeypatch.setattr(pipeline, "llm_review", _boom)
    res = pipeline.review_code(code, mode="bandit")
    assert res["meta"]["mode"] == "bandit"
    assert res["meta"]["bandit_count"] == 1
    assert res["meta"]["llm_count"] == 0
    assert res["meta"]["llm_error"] is None


def test_mode_llm_skips_bandit(monkeypatch):
    code = "import subprocess\nsubprocess.call('ls', shell=True)\n"
    monkeypatch.setattr(pipeline, "llm_is_configured", lambda: True)

    def _boom(_code):
        raise AssertionError("mode=llm không được chạy Bandit")

    monkeypatch.setattr(pipeline, "run_bandit", _boom)
    monkeypatch.setattr(pipeline, "llm_review", lambda *_args, **_kwargs: [dict(LLM_ISSUE)])
    res = pipeline.review_code(code, mode="llm")
    assert res["meta"]["mode"] == "llm"
    assert res["meta"]["bandit_count"] == 0
    assert res["meta"]["llm_count"] == 1
    assert res["issues"][0]["source"] == "llm"


def test_mode_hybrid_merges_both(monkeypatch):
    code = "import subprocess\nsubprocess.call('ls', shell=True)\n"
    monkeypatch.setattr(pipeline, "run_bandit", lambda _code: [dict(BANDIT_ISSUE)])
    monkeypatch.setattr(pipeline, "llm_is_configured", lambda: True)
    monkeypatch.setattr(pipeline, "llm_review", lambda *_args, **_kwargs: [dict(LLM_ISSUE)])
    res = pipeline.review_code(code, mode="hybrid")
    assert res["meta"]["mode"] == "hybrid"
    assert res["meta"]["bandit_count"] == 1
    assert res["meta"]["llm_count"] == 1
    assert len(res["issues"]) == 1
    assert res["issues"][0]["source"] == "both"


def test_mode_llm_without_config(monkeypatch):
    monkeypatch.setattr(pipeline, "run_bandit", lambda _code: [dict(BANDIT_ISSUE)])
    monkeypatch.setattr(pipeline, "llm_is_configured", lambda: False)
    res = pipeline.review_code("x = 1\n", mode="llm")
    assert res["meta"]["mode"] == "llm"
    assert res["meta"]["bandit_count"] == 0
    assert res["issues"] == []
    assert res["meta"]["llm_error"]


def test_normalize_mode_falls_back_to_hybrid():
    assert pipeline.normalize_mode("BANDIT") == "bandit"
    assert pipeline.normalize_mode("unknown") == "hybrid"
    assert pipeline.normalize_mode(None) == "hybrid"
