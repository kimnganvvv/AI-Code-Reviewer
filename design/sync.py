#!/usr/bin/env python3
"""Sync design tokens/components into the app stylesheet folders.

Source of truth: design/tokens.css + design/components.css.
Generated files must not be edited by hand.
"""
import shutil
from pathlib import Path

DESIGN_DIR = Path(__file__).resolve().parent
ROOT = DESIGN_DIR.parent

TARGETS = [
    (DESIGN_DIR / "tokens.css", ROOT / "extension" / "src" / "tokens.css"),
    (DESIGN_DIR / "components.css", ROOT / "extension" / "src" / "components.css"),
    (DESIGN_DIR / "tokens.css", ROOT / "backend" / "web" / "static" / "css" / "tokens.css"),
    (DESIGN_DIR / "components.css", ROOT / "backend" / "web" / "static" / "css" / "components.css"),
]

HEADER = "/* AUTO-GENERATED from design/ - do not edit by hand. */\n"


def main() -> int:
    for src, dst in TARGETS:
        if not src.exists():
            print(f"[SKIP] missing source: {src}")
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        content = HEADER + src.read_text(encoding="utf-8")
        dst.write_text(content, encoding="utf-8")
        print(f"[OK] {src.name} -> {dst.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
