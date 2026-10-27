# AI Code Reviewer — Chrome Extension

## Cài đặt extension

1. Mở Chrome, truy cập `chrome://extensions/`
2. Bật **"Chế độ dành cho nhà phát triển"** (góc trên phải)
3. Nhấn **"Tải tiện ích đã giải nén"** (Load unpacked)
4. Chọn thư mục `extension/` của project này
5. Extension "AI Code Reviewer" xuất hiện trong danh sách

## Chạy backend (cần thiết khi USE_MOCK = false)

Từ thư mục gốc project:

```powershell
# Windows PowerShell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r backend\requirements.txt
python -m uvicorn app.main:app --app-dir backend --port 8000
```

- Mở http://localhost:8000/health → phải trả về `{"status":"ok",...}`
- Nếu dùng LLM: tạo `backend/.env` với `LLM_API_KEY`, rồi restart server.

## Cấu hình USE_MOCK

File `extension/src/config.js`:

```js
export const USE_MOCK = false;  // true = dùng mock, false = gọi backend thật
export const LOCAL_URL = "http://localhost:8000";
export const DEPLOY_URL = "";    // URL deploy (Render/Railway), để rỗng nếu chưa có
```

- `USE_MOCK = true`: không cần backend, dùng dữ liệu giả trong `src/mock-response.json`
- `USE_MOCK = false`: gọi backend tại `LOCAL_URL` (hoặc `DEPLOY_URL` nếu có)

## Chọn chế độ review

Trong side panel, dropdown **"Chế độ review"**:
- **Bandit**: chỉ chạy Bandit.
- **Công cụ tĩnh**: Bandit + Ruff + bộ phát hiện AST, không cần LLM.
- **LLM**: phân tích bằng LLM độc lập.
- **Công cụ + LLM lọc**: LLM thẩm định ứng viên từ công cụ.
- **Hybrid** (mặc định): công cụ tĩnh + LLM lọc + LLM tìm lỗi còn thiếu.

Chế độ được lưu tự động, lần sau mở lại vẫn giữ nguyên.

## Cách dùng

1. **Bôi đen code** trên bất kỳ trang web nào (GitHub, StackOverflow, file local...)
2. Click chuột phải → **"Review với AI Code Reviewer"**
3. Hoặc nhấp vào **biểu tượng extension** để mở side panel, rồi dán code vào ô nhập liệu
4. Nhấn **"Phân tích"** hoặc `Ctrl+Enter`

## Lỗi thường gặp

| Lỗi | Nguyên nhân | Cách xử lý |
|-----|-------------|------------|
| "Backend: không kết nối" | Backend chưa chạy hoặc sai cổng | Chạy `python -m uvicorn...`, kiểm tra cổng 8000 |
| "Không kết nối được máy chủ" | Network error / CORS | Kiểm tra `host_permissions` trong manifest, backend CORS allow_origins=["*"] |
| "Code quá dài (X ký tự, giới hạn Y)" | Code vượt `MAX_CODE_LENGTH` | Rút gọn code, hoặc tăng `MAX_CODE_LENGTH` trong `backend/.env` |
| "LLM chưa cấu hình trên máy chủ..." | Chọn LLM/Hybrid nhưng backend chưa có `LLM_API_KEY` | Thêm `LLM_API_KEY` vào `backend/.env`, restart server |
| Menu chuột phải không hiện | Không có chữ được bôi đen | Bôi đen đoạn code trước rồi mới click chuột phải |
| Kết quả cũ hiện ra | Đang phân tích thì bôi đen đoạn mới | Extension tự huỷ request cũ, chờ request mới xong |
| File icon không load | Icon thiếu | Kiểm tra thư mục `extension/icons/` có 3 file png |

## Cấu trúc thư mục extension/

```
extension/
├── manifest.json
├── background.js
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── src/
│   ├── api.js        # Gọi API, timeout, retry
│   ├── config.js     # USE_MOCK, URL
│   ├── render.js     # Render thẻ lỗi
│   ├── storage.js    # Lưu setting (mode)
│   └── mock-response.json
└── sidepanel/
    ├── sidepanel.html
    ├── sidepanel.css
    └── sidepanel.js  # Logic chính
```
