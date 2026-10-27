"""Contract test: đảm bảo response luôn đúng 10 trường theo hợp đồng v2."""
from fastapi.testclient import TestClient

import app.main as main_module
from app.main import app
from app.mock_data import SAMPLE_CODE, mock_issues

client = TestClient(app)


def _fake_result(mode: str) -> dict:
    return {"issues": [], "meta": {"mode": mode}}


def test_review_accepts_mode_in_body(monkeypatch):
    captured = {}

    def fake_review(code: str, mode: str) -> dict:
        captured["mode"] = mode
        return _fake_result(mode)

    monkeypatch.setattr(main_module, "review_code", fake_review)
    r = client.post("/review", json={"code": "x = 1", "mode": "llm"})
    assert r.status_code == 200
    assert captured["mode"] == "llm"
    assert r.json()["meta"]["mode"] == "llm"


def test_review_query_mode_overrides_body(monkeypatch):
    captured = {}

    def fake_review(code: str, mode: str) -> dict:
        captured["mode"] = mode
        return _fake_result(mode)

    monkeypatch.setattr(main_module, "review_code", fake_review)
    r = client.post("/review?mode=bandit", json={"code": "x = 1", "mode": "llm"})
    assert r.status_code == 200
    assert captured["mode"] == "bandit"


def test_review_rejects_invalid_mode():
    r = client.post("/review", json={"code": "x = 1", "mode": "fast"})
    assert r.status_code == 422


def test_review_preserves_code_verbatim(monkeypatch):
    captured = {}
    code = "\n# Tiếng Việt ✓\r\n\tmessage = \"\"\"line  \r\nnext\"\"\"  \r\n\r\n"

    def fake_review(received_code: str, mode: str) -> dict:
        captured["code"] = received_code
        return _fake_result(mode)

    monkeypatch.setattr(main_module, "review_code", fake_review)
    r = client.post("/review", json={"code": code, "mode": "bandit"})
    assert r.status_code == 200
    assert captured["code"] == code


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "llm_enabled" in body
    assert "max_code_length" in body


def test_web_and_static_assets_are_served():
    page = client.get("/")
    assert page.status_code == 200
    assert 'id="fMode"' in page.text
    assert "static/js/app.js?v=11" in page.text

    for path in (
        "/static/css/app.css",
        "/static/js/app.js",
        "/static/vendor/codemirror.min.js",
        "/static/vendor/python.min.js",
    ):
        response = client.get(path)
        assert response.status_code == 200, path
        assert response.content


def test_sample():
    r = client.get("/sample")
    assert r.status_code == 200
    assert "code" in r.json()


def test_mock_review_contract():
    r = client.post("/mock/review", json={"code": "x = 1"})
    assert r.status_code == 200
    data = r.json()
    assert "issues" in data and "meta" in data
    assert isinstance(data["issues"], list)
    assert isinstance(data["meta"], dict)
    for it in data["issues"]:
        # Đủ 10 trường theo hợp đồng
        for k in ["line", "type", "severity", "confidence", "cwe_id", "message", "explanation", "suggestion", "source"]:
            assert k in it
        assert it["type"] in {"security", "bug", "quality"}
        assert it["severity"] in {"high", "medium", "low"}
        assert it["confidence"] in {"high", "medium", "low"}
        assert it["source"] in {"bandit", "llm", "both"}


def test_mock_issues_point_to_real_sample_lines():
    """Mock phải trỏ đúng dòng trong SAMPLE_CODE để highlight 2 chiều hoạt động."""
    lines = SAMPLE_CODE.splitlines()
    by_line = {issue["line"]: issue for issue in mock_issues()}

    assert set(by_line) == {2, 5, 9, 14, 18}
    assert "import sqlite3" in lines[2 - 1]
    assert "PASSWORD" in lines[5 - 1]
    assert "SELECT" in lines[9 - 1]
    assert "subprocess.call" in lines[14 - 1]
    assert "len(values)" in lines[18 - 1]


def test_review_empty_code():
    for code in ("", "   ", "\n\t  "):
        r = client.post("/review", json={"code": code})
        assert r.status_code == 400


def test_review_too_long():
    r = client.post("/review", json={"code": "x" * 20005})
    assert r.status_code == 413
