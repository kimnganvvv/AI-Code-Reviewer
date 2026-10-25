"""Vẽ lại bảng và biểu đồ từ kết quả thô (không gọi lại API)."""
import argparse
import json
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.dataset import load_dataset
from src.report import MODE_ORDER, evaluate, format_table, plot_all


def latest_per_mode(raw_dir: Path, split: str):
    best = {}
    for p in sorted(raw_dir.glob("*.json")):  # tên file có timestamp nên sắp xếp là theo thời gian
        raw = json.loads(p.read_text(encoding="utf-8"))
        if raw.get("split") == split:
            best[raw["mode"]] = raw
    return [best[m] for m in MODE_ORDER if m in best]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", default="dev", choices=["dev", "holdout", "all"])
    ap.add_argument("--samples", default=str(ROOT / "samples"))
    ap.add_argument("--raw", default=str(ROOT / "results" / "raw"))
    ap.add_argument("--figures", default=str(ROOT / "results" / "figures"))
    ap.add_argument("--tol", type=int, default=2)
    ap.add_argument("--include-invalid", action="store_true", help="vẽ cả chế độ có kết quả không hợp lệ (chỉ để debug)")
    args = ap.parse_args()

    runs = latest_per_mode(Path(args.raw), args.split)
    if not runs:
        sys.exit(f"Không có kết quả thô nào cho split={args.split} trong {args.raw}")
    samples = load_dataset(args.samples, args.split)
    evals = [evaluate(r, samples, args.tol) for r in runs]
    print(format_table(evals))

    summary = Path(args.figures).parent / f"summary_{args.split}.json"
    summary.write_text(json.dumps(evals, ensure_ascii=False, indent=2), encoding="utf-8")
    skipped = [e["mode"] for e in evals if not e["valid"]]
    if skipped and not args.include_invalid:
        print(f"Bỏ qua khi vẽ (kết quả không hợp lệ): {', '.join(skipped)}")
    for p in plot_all(evals, args.figures, include_invalid=args.include_invalid):
        print("Đã vẽ", p)
    print("Đã ghi", summary)


if __name__ == "__main__":
    main()
