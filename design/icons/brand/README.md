# Brand icons

Paste ảnh gốc vào đây với tên `logo-source.jpg` (hoặc `logo-source.png`), rồi chạy:

```powershell
python design\icons\make_brand_icons.py
python design\sync.py
```

Script sinh ra:

| File | Kích thước | Dùng cho |
|---|---|---|
| `logo.png` | 256x256 | brand mark header web + side panel |
| `icon16.png` | 16x16 | extension action + manifest |
| `icon48.png` | 48x48 | extension action + manifest |
| `icon128.png` | 128x128 | extension icon + Chrome Web Store |
| `favicon.ico` | 16/32/48 (multi-size) | favicon web |

Ghi chú:

- Ảnh gốc nên vuông (ảnh không vuông sẽ được crop giữa).
- PNG nên có nền trong suốt nếu muốn icon không bị nền trắng.
- Giữ đúng tên file để `design/sync.py` và `extension/manifest.json` khớp nhau.
- Không sửa tay file đã sync trong `extension/icons/` hay `backend/web/static/icons/`.
