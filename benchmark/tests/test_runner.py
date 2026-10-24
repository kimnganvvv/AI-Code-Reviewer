import json

from src.client import ReviewResult
from src.dataset import Sample
from src.report import evaluate
from src.runner import run_benchmark, save_run


class FakeClient:
    """Trả kết quả dựng sẵn theo đường dẫn mẫu, không gọi mạng."""

    def __init__(self, table, meta=None, error=None):
        self.table, self.meta, self.error, self.calls = table, meta or {}, error, []

    def review(self, code, mode):
        self.calls.append(mode)
        return ReviewResult(issues=self.table.get(code, []), meta=self.meta, latency=0.5, error=self.error)


def samples():
    return [
        Sample("security/a.py", "A", "security", False, "dev", ({"line": 5, "type": "security", "cwe_id": "CWE-89"},)),
        Sample("bug/b.py", "B", "bug", False, "dev", ({"line": 3, "type": "bug", "cwe_id": None},)),
        Sample("clean/c.py", "C", "clean", True, "dev", ()),
        Sample("clean/d.py", "D", "clean", True, "dev", ()),
        Sample("injection/i.py", "I", "prompt_injection", False, "dev", ({"line": 2, "type": "security", "cwe_id": "CWE-89"},)),
    ]


TABLE = {
    "A": [{"line": 5, "type": "security"}],                 # TP
    "B": [],                                               # FN
    "C": [{"line": 1, "type": "security"}],                 # FP trên file sạch
    "D": [],
    "I": [{"line": 2, "type": "security"}],                 # injection: đạt
}


def test_end_to_end_metrics():
    raw = run_benchmark(FakeClient(TABLE), samples(), "hybrid")
    ev = evaluate(raw, samples())
    m = ev["metrics"]
    assert (m["tp"], m["fp"], m["fn"]) == (1, 1, 1)           # injection không tính vào P/R
    assert m["precision"] == 0.5 and m["recall"] == 0.5
    assert m["fpr"] == 0.5 and m["clean_flagged"] == 1 and m["clean_total"] == 2
    assert m["injection_pass"] == 1 and m["injection_total"] == 1
    assert m["recall_by_category"] == {"bug": 0.0, "security": 1.0}
    assert ev["valid"] is True
    assert ev["latency"]["median"] == 0.5


def test_llm_error_marks_run_invalid_for_llm_modes():
    client = FakeClient(TABLE, meta={"llm_error": "chưa cấu hình"})
    assert evaluate(run_benchmark(client, samples(), "hybrid"), samples())["valid"] is False
    assert evaluate(run_benchmark(client, samples(), "llm"), samples())["valid"] is False


def test_llm_error_ignored_in_bandit_mode():
    client = FakeClient(TABLE, meta={"llm_error": "x"})
    assert evaluate(run_benchmark(client, samples(), "bandit"), samples())["valid"] is True


def test_http_error_marks_invalid():
    ev = evaluate(run_benchmark(FakeClient({}, error="HTTP 500"), samples(), "bandit"), samples())
    assert ev["valid"] is False and ev["errors"] == 5


def test_repeats_call_client_each_time_and_are_averaged():
    client = FakeClient(TABLE)
    raw = run_benchmark(client, samples(), "bandit", repeats=3)
    assert len(client.calls) == 15
    assert evaluate(raw, samples())["metrics"]["precision"] == 0.5


def test_save_run_writes_json(tmp_path):
    raw = run_benchmark(FakeClient(TABLE), samples(), "bandit")
    path = save_run(raw, tmp_path)
    assert path.name.startswith("bandit_dev_")
    assert json.loads(path.read_text(encoding="utf-8"))["mode"] == "bandit"


def test_plot_skips_invalid_modes(tmp_path):
    from src.report import plot_all

    bad = evaluate(run_benchmark(FakeClient(TABLE, meta={"llm_error": "x"}), samples(), "llm"), samples())
    good = evaluate(run_benchmark(FakeClient(TABLE), samples(), "bandit"), samples())
    assert plot_all([bad], tmp_path) == []                      # chỉ có kết quả hỏng thì không vẽ gì
    files = plot_all([bad, good], tmp_path)
    assert files and all(p.exists() for p in files)
    assert all("Only LLM" not in p.name for p in files)
