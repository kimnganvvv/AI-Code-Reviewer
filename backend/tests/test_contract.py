"""Contract test: đảm bảo response luôn đúng 10 trường theo hợp đồng v2."""
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "llm_enabled" in body
    assert "max_code_length" in body


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


def test_review_empty_code():
    r = client.post("/review", json={"code": "   "})
    assert r.status_code == 400


def test_review_too_long():
    r = client.post("/review", json={"code": "x" * 20005})
    assert r.status_code == 413
