#!/usr/bin/env python3
"""Sync design tokens/components/icons into the app asset folders.

Source of truth:
  design/tokens.css, design/components.css, design/icons/{brand,ui}/
Generated files must not be edited by hand.
"""
import shutil
from pathlib import Path

DESIGN_DIR = Path(__file__).resolve().parent
ROOT = DESIGN_DIR.parent
ICON_DIR = DESIGN_DIR / "icons"

CSS_TARGETS = [
    (DESIGN_DIR / "tokens.css", ROOT / "extension" / "src" / "tokens.css"),
    (DESIGN_DIR / "components.css", ROOT / "extension" / "src" / "components.css"),
]

ICON_TARGETS = [
    (ICON_DIR / "brand", ROOT / "extension" / "icons"),
    (ICON_DIR / "ui", ROOT / "extension" / "icons"),
    (ICON_DIR / "brand", ROOT / "backend" / "web" / "static" / "icons"),
    (ICON_DIR / "ui", ROOT / "backend" / "web" / "static" / "icons"),
]

FAVICON_SRC = ICON_DIR / "brand" / "favicon.ico"
FAVICON_DST = ROOT / "backend" / "web" / "favicon.ico"

HEADER = "/* AUTO-GENERATED from design/ - do not edit by hand. */\n"
ICON_SUFFIXES = {".png", ".ico", ".svg"}


def _rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def _sync_css() -> None:
    for src, dst in CSS_TARGETS:
        if not src.exists():
            print(f"[SKIP] missing source: {_rel(src)}")
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(HEADER + src.read_text(encoding="utf-8"), encoding="utf-8")
        print(f"[OK] {src.name} -> {_rel(dst)}")


def _sync_icons() -> None:
    copied = 0
    for src_dir, dst_dir in ICON_TARGETS:
        files = []
        if src_dir.exists():
            files = sorted(
                p for p in src_dir.iterdir()
                if p.is_file()
                and p.suffix.lower() in ICON_SUFFIXES
                and p.name != FAVICON_SRC.name
            )
        if not files:
            print(f"[SKIP] no icon files in {_rel(src_dir)}")
            continue
        dst_dir.mkdir(parents=True, exist_ok=True)
        for src in files:
            dst = dst_dir / src.name
            shutil.copy2(src, dst)
            copied += 1
            print(f"[OK] {_rel(src)} -> {_rel(dst)}")
    if not copied:
        print("[SKIP] no icons to sync yet - paste files into design/icons/brand or design/icons/ui")


def _sync_favicon() -> None:
    if not FAVICON_SRC.exists():
        print(f"[SKIP] missing source: {_rel(FAVICON_SRC)}")
        return
    FAVICON_DST.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(FAVICON_SRC, FAVICON_DST)
    print(f"[OK] {_rel(FAVICON_SRC)} -> {_rel(FAVICON_DST)}")


def main() -> int:
    _sync_css()
    _sync_icons()
    _sync_favicon()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
