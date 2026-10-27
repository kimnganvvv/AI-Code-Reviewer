"""Tests for the current three-layer review pipeline."""

from app import pipeline


def _candidate():
    return {
        "tool": "bandit",
        "rule_id": "B602",
        "line": 2,
        "end_line": 2,
        "type": "security",
        "severity": "high",
        "confidence": "high",
        "cwe_id": "CWE-78",
        "message": "shell=True",
        "explanation": "Bandit finding",
        "suggestion": "",
    }


def test_validate_lines_drops_invalid():
    code = "a = 1\nb = 2\n"
    valid, dropped = pipeline.validate_lines([{"line": 1}, {"line": 999}], code)
    assert dropped == 1
    assert valid == [{"line": 1}]


def test_normalize_mode_accepts_all_current_modes():
    for mode in ("bandit", "tools", "llm", "filter", "hybrid"):
        assert pipeline.normalize_mode(mode) == mode
    assert pipeline.normalize_mode("unknown") == "hybrid"


def test_bandit_mode_runs_only_bandit_tool(monkeypatch):
    seen = {}

    def collect(_code, **kwargs):
        seen.update(kwargs)
        return {"candidates": [_candidate()], "counts": {"bandit": 1, "ruff": 0, "static": 0}, "warnings": [], "merged": 0}

    monkeypatch.setattr(pipeline, "collect_candidates", collect)
    result = pipeline.review_code("import subprocess\nsubprocess.call('ls', shell=True)", "bandit")

    assert seen == {"bandit": True, "ruff": False, "static": False}
    assert result["meta"]["mode"] == "bandit"
    assert result["issues"][0]["source"] == "bandit"


def test_llm_mode_skips_static_tools(monkeypatch):
    def fail_if_called(*_args, **_kwargs):
        raise AssertionError("mode=llm must not run static tools")

    monkeypatch.setattr(pipeline, "collect_candidates", fail_if_called)
    monkeypatch.setattr(pipeline, "llm_is_configured", lambda: True)
    monkeypatch.setattr(pipeline, "llm_review", lambda *_args: {
        "new_issues": [], "dropped_new_issues": 0, "rejected_suggestions": 0,
    })

    result = pipeline.review_code("x = 1", "llm")
    assert result["meta"]["mode"] == "llm"
    assert result["meta"]["bandit_count"] == 0
    assert result["issues"] == []


def test_hybrid_runs_filter_and_gap_layers(monkeypatch):
    calls = []

    monkeypatch.setattr(pipeline, "collect_candidates", lambda _code, **_kwargs: {
        "candidates": [_candidate()],
        "counts": {"bandit": 1, "ruff": 0, "static": 0},
        "warnings": [],
        "merged": 0,
    })
    monkeypatch.setattr(pipeline, "llm_is_configured", lambda: True)

    def filter_candidates(_code, candidates):
        calls.append("filter")
        return {
            "verdicts": [{
                "candidate_id": candidates[0]["candidate_id"],
                "keep": True,
                "confidence": "high",
                "explanation": "Đã xác nhận shell=True.",
                "line": None,
                "end_line": None,
                "suggestion": None,
            }],
            "rejected_suggestions": 0,
        }

    def find_gaps(_code):
        calls.append("gap")
        return {"issues": [], "dropped": 0, "rejected_suggestions": 0}

    monkeypatch.setattr(pipeline, "llm_filter", filter_candidates)
    monkeypatch.setattr(pipeline, "llm_find_gaps", find_gaps)

    result = pipeline.review_code("import subprocess\nsubprocess.call('ls', shell=True)", "hybrid")
    assert calls == ["filter", "gap"]
    assert result["meta"]["mode"] == "hybrid"
    assert result["issues"][0]["source"] == "both"
    assert result["meta"]["llm_error"] is None
