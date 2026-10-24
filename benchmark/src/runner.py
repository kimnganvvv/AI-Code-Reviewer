"""Chạy toàn bộ mẫu qua API và lưu kết quả THÔ (chưa chấm điểm)."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path


def run_benchmark(client, samples, mode: str, repeats: int = 1, split: str = "dev", progress=None) -> dict:
    files = {}
    for i, sample in enumerate(samples, start=1):
        runs = []
        for _ in range(repeats):
            res = client.review(sample.code, mode)
            runs.append(
                {"issues": res.issues, "meta": res.meta, "latency": res.latency, "error": res.error}
            )
        files[sample.path] = {"runs": runs}
        if progress:
            progress(i, len(samples), sample.path)
    return {
        "mode": mode,
        "split": split,
        "repeats": repeats,
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "files": files,
    }


def save_run(raw: dict, out_dir) -> Path:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = out_dir / f"{raw['mode']}_{raw['split']}_{stamp}.json"
    path.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
    return path
