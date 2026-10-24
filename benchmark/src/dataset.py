"""Nạp bộ mẫu và nhãn từ samples/labels.json."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Sample:
    path: str
    code: str
    category: str
    is_clean: bool
    split: str
    issues: tuple  # các nhãn lỗi chuẩn (dict)


def load_dataset(samples_dir, split: str = "dev") -> list[Sample]:
    """split: 'dev', 'holdout' hoặc 'all'."""
    samples_dir = Path(samples_dir)
    labels = json.loads((samples_dir / "labels.json").read_text(encoding="utf-8"))
    out = []
    for rel, meta in labels.items():
        sample_split = meta.get("split", "dev")
        if split != "all" and sample_split != split:
            continue
        code = (samples_dir / rel).read_text(encoding="utf-8")
        out.append(
            Sample(
                path=rel,
                code=code,
                category=meta["category"],
                is_clean=bool(meta["is_clean"]),
                split=sample_split,
                issues=tuple(meta["issues"]),
            )
        )
    return out
