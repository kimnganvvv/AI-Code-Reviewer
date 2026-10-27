#!/usr/bin/env python3
"""Generate brand icon sizes from the master image in design/icons/brand/.

Paste/replace the master (logo-source.jpg or logo-source.png), then run:
    python design/icons/make_brand_icons.py
    python design/sync.py
"""
from pathlib import Path

from PIL import Image

BRAND = Path(__file__).resolve().parent / "brand"
SOURCES = [
    BRAND / "logo-source.jpg",
    BRAND / "logo-source.png",
    BRAND / "logo.png",
    BRAND / "logo.jpg",
]
PNG_SIZES = {
    "logo.png": 256,
    "icon128.png": 128,
    "icon48.png": 48,
    "icon16.png": 16,
}
FAVICON_SIZES = [(16, 16), (32, 32), (48, 48)]


def _square(img: Image.Image) -> Image.Image:
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    return img.crop((left, top, left + side, top + side))


def main() -> int:
    src = next((p for p in SOURCES if p.exists()), None)
    if src is None:
        print(f"[SKIP] no master image in {BRAND}")
        return 0

    img = _square(Image.open(src).convert("RGB"))
    for name, size in PNG_SIZES.items():
        dst = BRAND / name
        img.resize((size, size), Image.LANCZOS).save(dst, "PNG", optimize=True)
        print(f"[OK] {src.name} -> {dst.name} ({size}x{size})")

    favicon = BRAND / "favicon.ico"
    img.resize((256, 256), Image.LANCZOS).save(favicon, sizes=FAVICON_SIZES)
    print(f"[OK] {src.name} -> {favicon.name} ({FAVICON_SIZES})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
