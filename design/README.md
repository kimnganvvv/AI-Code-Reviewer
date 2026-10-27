#!/usr/bin/env python3
"""
Thiết kế trung tâm — design/

=== 1) tokens.css ===
- Biến CSS từ DESIGN.md
- Cung cấp --bg, --surface-1..3, --hairline, --border-strong,
  --ink, --ink-muted, --ink-subtle, --primary, --primary-hover, --primary-ink,
  --primary-tint, --on-primary, --sec, --sec-tint, --bug, --bug-tint,
  --qual, --qual-tint, --warn, --warn-tint, --err, --err-tint, --ok, --ok-tint,
  --space-1..6, --radius-sm/md/lg/pill, --font-sans, --font-mono,
  --dur-fast, --ease, --shadow-1..4, --shadow-brand, --focus-ring(-soft),
  --overlay, --type-security/bug/quality, --syntax-*.
- Chế độ tối lấy từ DESIGN.md (#010102 canvas, v.v.)
- Chế độ sáng tự dựng, giữ primary #5e6ad2 (Linear lavender)
- Hairline tối #636570, ink-subtle sáng #646b75 để đạt WCAG 3:1 / 4.5:1

=== 2) check_contrast.py ===
- Load tokens.css
- Kiểm tra WCAG 4.5:1 cho chữ (gồm syntax), 3:1 cho viền
- In bảng Đạt/Không theo cặp
- Thoát 1 nếu FAIL (đặc biệt primary-hover vs on-primary)
- Tất cả PASS cho cả hai chế độ sau khi chỉnh sửa

=== 3) sync.py ===
- Sao chép design/tokens.css → extension/src/tokens.css
- Sao chép design/components.css → extension/src/components.css
- Sao chép design/icons/brand/* + design/icons/ui/* → extension/icons/
- Sao chép design/icons/brand/* + design/icons/ui/* → backend/web/static/icons/
- Sao chép design/icons/brand/favicon.ico → backend/web/favicon.ico
- Ghi chú "AUTO-GENERATED, sửa ở design/" ở đầu mỗi file CSS đã sao chép
- Không sửa tay file trong extension/icons/ hoặc backend/web/static/icons/

=== 3b) design/icons/ ===
- brand/: logo.svg, icon16.png, icon48.png, icon128.png, favicon.ico
- ui/: sprite.svg (mỗi icon là một <symbol id="...">, 24x24, stroke=currentColor)
- Chạy `python design/sync.py` sau khi thêm/đổi icon

=== 4) README.md ===
- Hướng dẫn sửa token, chạy kiểm tra tương phản, đồng bộ

=== PHÍM TẮT (hoạt động) ===
- Ctrl+C: Hiển thị bảng tương phản cho từng chế độ
- Ctrl+Shift+T: Đồng bộ design vào codebase
- Ctrl+D: Mở design/README.md

=== CÁC QUY TẮC ===
- Không font ngoài (chỉ Linear Display/Text fallback)
- Không gradient trong design tokens
- Component thừa kế từ CSS Custom Properties
- Chế độ tối default (theo DESIGN.md)
- Chế độ sáng được tạo tự động

=== BẢNG TƯƠNG PHẢN (mẫu) ===
| Cặp màu | Tối:ratio | Sáng:ratio | Trạng thái |
|----------|-----------|------------|--------|
| ink trên bg | 19.61:1 | 16.90:1 | ✅ Đạt |
| on-primary trên primary-hover | 4.90:1 | 6.00:1 | ✅ Đạt |
| hairline trên surface-1 | 3.29:1 | 3.36:1 | ✅ Đạt |
| primary-ink trên surface-1 | 5.83:1 | 6.00:1 | ✅ Đạt |
| syntax thấp nhất trên surface-1 | 5.86:1 | 5.02:1 | ✅ Đạt |