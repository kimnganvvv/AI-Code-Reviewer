# Icons dùng chung — Web + Extension

Nguồn duy nhất (single source of truth). Paste/sửa icon trong thư mục này, sau đó chạy:

```powershell
python design\sync.py
```

`sync.py` sẽ copy sang:

- `extension/icons/` — bắt buộc, Chrome extension phải tự chứa icon
- `backend/web/static/icons/` — web UI dùng
- `backend/web/favicon.ico` — favicon của web

Không sửa trực tiếp file trong `extension/icons/` hay `backend/web/static/icons/`.

## Cấu trúc

```
design/icons/
  brand/    logo + icon bộ sản phẩm (png/ico/svg)
  ui/       sprite SVG cho icon line trong giao diện
```

## Quy tắc

- Chỉ các file `.png`, `.ico`, `.svg` được sync; README và file nguồn `.jpg` bị bỏ qua.
- `brand/logo-source.jpg` (hoặc `.png`) là ảnh gốc; chạy `python design/icons/make_brand_icons.py`
  để sinh `logo.png`, `icon16/48/128.png`, `favicon.ico`.
- Tên file ở `brand/` phải khớp `extension/manifest.json`:
  `icon16.png`, `icon48.png`, `icon128.png`.
- `favicon.ico` nên chứa nhiều kích thước 16/32/48.
- `logo.png` dùng cho brand mark ở header web và side panel.
- Icon UI gom vào `ui/sprite.svg`, mỗi icon là một `<symbol id="...">` (viewBox 24x24,
  `fill="none"`, `stroke="currentColor"` để ăn theo theme sáng/tối).
