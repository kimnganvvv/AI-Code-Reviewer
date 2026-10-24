# AI Code Reviewer

Công cụ review mã Python kết hợp Bandit (SAST) và LLM trong một luồng Hybrid. Bandit phát hiện lỗi bảo mật; LLM thẩm định cảnh báo và bổ sung lỗi bug/quality. Kết quả được chuẩn hóa, kiểm tra số dòng, gộp trùng và trả về JSON v2 thống nhất.

## Tính năng

- Ba chế độ review: `bandit`, `llm`, `hybrid`.
- Chạy Bandit không cần API key; chế độ Hybrid tự fallback khi LLM chưa được cấu hình.
- Web UI offline-friendly, không cần Node.js hay bước build frontend.
- Click findings để nhảy đến dòng code; lọc theo loại, mức độ và độ tin cậy.
- Lịch sử review lưu cục bộ bằng Local Storage trong trình duyệt, không dùng database hay endpoint lịch sử trên server.

## Yêu cầu

| Thành phần | Phiên bản / ghi chú |
|---|---|
| Python | 3.10+ |
| pip | Đi kèm Python |
| Node.js | Không cần |
| Database | Không cần |

## Chạy nhanh

Từ thư mục gốc project trên Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r backend\requirements.txt
Copy-Item .\backend\.env.example .\backend\.env
python -m uvicorn app.main:app --app-dir backend --port 8000
```

Mở các địa chỉ sau:

- Web UI: <http://localhost:8000>
- API docs: <http://localhost:8000/docs>
- Health check: <http://localhost:8000/health>

Nếu PowerShell chặn `Activate.ps1`, chạy `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`, sau đó kích hoạt lại môi trường ảo.

Trên macOS/Linux:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
cp backend/.env.example backend/.env
python -m uvicorn app.main:app --app-dir backend --port 8000
```

## Cấu hình LLM

File cấu hình là `backend/.env`. Không tạo file này vẫn chạy được bằng Bandit.

```ini
USE_LLM=1
LLM_API_KEY=
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
LLM_TEMPERATURE=0
MAX_CODE_LENGTH=20000
BANDIT_TIMEOUT=30
LLM_TIMEOUT=90
```

| Biến | Mặc định | Ý nghĩa |
|---|---:|---|
| `USE_LLM` | `1` | Đặt `0` để tắt LLM hoàn toàn |
| `LLM_API_KEY` | rỗng | API key của nhà cung cấp cloud |
| `LLM_BASE_URL` | OpenAI API | Endpoint tương thích OpenAI |
| `LLM_MODEL` | `gpt-4o-mini` | Tên model |
| `LLM_TEMPERATURE` | `0` | Temperature khi gọi LLM |
| `MAX_CODE_LENGTH` | `20000` | Số ký tự code tối đa |
| `BANDIT_TIMEOUT` | `30` | Timeout Bandit, tính bằng giây |
| `LLM_TIMEOUT` | `90` | Timeout LLM, tính bằng giây |

Ollama và LM Studio có thể dùng URL localhost, không cần API key. Sau khi sửa `.env`, hãy khởi động lại server. Không commit file `backend/.env`.

## API

| Method | Path | Mô tả |
|---|---|---|
| `GET` | `/health` | Trạng thái server, LLM và giới hạn code |
| `GET` | `/sample` | Đoạn Python mẫu cho UI |
| `POST` | `/review` | Review thật với `mode=bandit`, `llm` hoặc `hybrid` |
| `POST` | `/mock/review` | Kết quả mô phỏng đúng contract, không cần API key |

`mode` nhận qua body hoặc query string; query string được ưu tiên. Không có endpoint `/history`: lịch sử là dữ liệu Local Storage phía trình duyệt.

Ví dụ chạy Bandit không cần API key:

```powershell
$body = @{ code = "import subprocess`nsubprocess.call('ls', shell=True)`n" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://localhost:8000/review?mode=bandit" `
  -ContentType "application/json" -Body $body
```

Hợp đồng request/response đầy đủ: [docs/API_CONTRACT.md](docs/API_CONTRACT.md).

## Lịch sử review trên trình duyệt

Sau mỗi lượt review thành công, UI lưu code, findings, metadata và thời điểm chạy vào Local Storage cùng origin với UI. Dữ liệu dùng khóa `ai-code-reviewer.review-history.v1` và giữ tối đa 12 bản ghi gần nhất.

Nút **Lịch sử** cho phép mở lại một lượt review, xóa từng mục hoặc xóa toàn bộ lịch sử. Lịch sử không được gửi lên server, không dùng MySQL và không đồng bộ giữa trình duyệt/thiết bị. Vì code được lưu cục bộ, hãy xóa lịch sử khi dùng máy dùng chung.

## Kiểm thử và kiểm tra mã

Cài thêm công cụ development trước khi chạy test:

```powershell
python -m pip install -r backend\requirements.txt
python -m pip install -r backend\requirements-dev.txt
python -m pytest
python -m ruff check backend
```

Test suite hiện có 17 test unit/contract. Có thể chạy riêng từ thư mục `backend` bằng `python -m pytest tests`.

## Cấu trúc project

```text
AI-Code-Reviewer/
├── backend/
│   ├── app/
│   │   ├── main.py           # FastAPI routes và static UI
│   │   ├── config.py         # Đọc cấu hình .env
│   │   ├── schemas.py        # JSON contract v2
│   │   ├── pipeline.py       # Validate dòng, merge/dedup, điều phối
│   │   ├── bandit_runner.py  # Chạy và chuẩn hóa Bandit
│   │   ├── llm_client.py     # LLM OpenAI-compatible
│   │   ├── prompts.py        # Prompt review
│   │   └── mock_data.py      # Code mẫu và mock response
│   ├── tests/
│   ├── web/                  # HTML/CSS/JS + CodeMirror offline
│   ├── requirements.txt
│   ├── requirements-dev.txt
│   └── .env.example
├── docs/
│   ├── API_CONTRACT.md
│   ├── ARCHITECTURE.md
│   └── HUONG_DAN_NGUOI_1.md
├── Procfile
├── render.yaml
└── pyproject.toml
```

## Deploy

- Render dùng `render.yaml` và chỉ cần cấu hình các biến LLM khi muốn bật LLM.
- Railway dùng `Procfile`:

  ```text
  web: uvicorn app.main:app --host 0.0.0.0 --port $PORT --app-dir backend
  ```

## Lỗi thường gặp

| Vấn đề | Cách xử lý |
|---|---|
| `uvicorn` không được nhận diện | Dùng `python -m uvicorn ...` trong môi trường ảo |
| `ModuleNotFoundError: app` | Chạy từ root với `--app-dir backend`, hoặc `cd backend` trước |
| Port 8000 đang bận | Đổi sang `--port 8001`, rồi mở `/?api=http://localhost:8001` |
| UI không kết nối được server | Kiểm tra server và URL API đang dùng |
| LLM chưa cấu hình | Dùng `mode=bandit`, hoặc điền API key/URL local rồi restart server |
| Không lưu được lịch sử | Kiểm tra Local Storage của trình duyệt có bị chặn hay không |

Xem thêm: [Architecture](docs/ARCHITECTURE.md) · [API contract](docs/API_CONTRACT.md) · [Hướng dẫn Người 1](docs/HUONG_DAN_NGUOI_1.md).
