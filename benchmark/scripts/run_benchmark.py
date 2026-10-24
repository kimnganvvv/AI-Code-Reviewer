"""Chạy đo: python scripts/run_benchmark.py --modes bandit llm hybrid"""
import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.client import HttpReviewClient  # noqa: E402
from src.dataset import load_dataset  # noqa: E402
from src.report import evaluate, format_table  # noqa: E402
from src.runner import run_benchmark, save_run  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:8000")
    ap.add_argument("--modes", nargs="+", default=["bandit"], choices=["bandit", "llm", "hybrid"])
    ap.add_argument("--split", default="dev", choices=["dev", "holdout", "all"])
    ap.add_argument("--repeats", type=int, default=1)
    ap.add_argument("--samples", default=str(ROOT / "samples"))
    ap.add_argument("--out", default=str(ROOT / "results" / "raw"))
    ap.add_argument("--tol", type=int, default=2)
    ap.add_argument("--force", action="store_true", help="vẫn chạy llm/hybrid dù /health báo LLM chưa bật")
    args = ap.parse_args()

    client = HttpReviewClient(args.api)
    try:
        health = client.health()
    except Exception as ex:  # noqa: BLE001
        sys.exit(f"Không kết nối được {args.api}/health: {ex}")
    print("Health:", health)
    needs_llm = any(m in ("llm", "hybrid") for m in args.modes)
    if needs_llm and not health.get("llm_enabled") and not args.force:
        sys.exit("LLM chưa được bật trên backend (llm_enabled=false). Điền LLM_API_KEY rồi khởi động lại, hoặc dùng --force.")

    samples = load_dataset(args.samples, args.split)
    print(f"Đã nạp {len(samples)} mẫu (split={args.split}).")

    evals = []
    for mode in args.modes:
        raw = run_benchmark(
            client, samples, mode, repeats=args.repeats, split=args.split,
            progress=lambda i, n, p, m=mode: print(f"[{m}] {i}/{n} {p}", end="\r"),
        )
        path = save_run(raw, args.out)
        print(f"\nĐã lưu {path}")
        evals.append(evaluate(raw, samples, args.tol))
    print()
    print(format_table(evals))


if __name__ == "__main__":
    main()
