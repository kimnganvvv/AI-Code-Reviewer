# AI Code Reviewer

Công cụ review code Python: kết hợp **Bandit (SAST)** với **LLM** theo hướng **Single-pass Hybrid** (Bandit phát hiện lỗi bảo mật, LLM thẩm định lại + bổ sung lỗi bug/quality trong 1 lượt gọi), sau đó lọc dòng ảo giác, gộp trùng và trả về **JSON v2** thống nhất.

- Web UI có sẵn trong `backend/web` — **không cần Node.js, không cần build frontend**.
- Chạy được ngay **không cần API key** ở chế độ `bandit`.
- Server **không tự chạy ngầm**: chỉ khởi động khi bạn gõ lệnh. Không dùng `--reload` trừ khi bạn muốn tự động restart khi sửa code.

---

## 1. Yêu cầu

| Thành phần | Ghi chú |
|---|---|
| Python | **3.10+** (đã kiểm tra với 3.14.7) |
| pip | Đi kèm Python |
| Hệ điều hành | Windows, macOS hoặc Linux |
| Node.js | **Không cần** |

Kiểm tra Python:

```powershell
python --version
```

---

## 2. Chạy nhanh (Windows PowerShell)

Mở PowerShell tại **thư mục gốc project** (thư mục chứa file `README.md` này), rồi chạy lần lượt:

```powershell
# 1) Tạo môi trường ảo (khuyến nghị)
python -m venv .venv

# 2) Kích hoạt môi trường ảo
.\.venv\Scripts\Activate.ps1

# 3) Cài thư viện
python -m pip install --upgrade pip
python -m pip install -r backend\requirements.txt

# 4) Tạo file cấu hình (tùy chọn — bỏ qua vẫn chạy được)
Copy-Item .\backend\.env.example .\backend\.env

# 5) Chạy server
python -m uvicorn app.main:app --app-dir backend --port 8000
```

Mở trình duyệt:

- Web UI: <http://localhost:8000>
- Swagger API: <http://localhost:8000/docs>
- Health check: <http://localhost:8000/health>

Dừng server: nhấn `Ctrl + C` trong cửa sổ PowerShell.

> Nếu PowerShell báo lỗi không cho chạy `Activate.ps1`, chạy lệnh sau rồi kích hoạt lại:
>
> ```powershell
> Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
> ```

### Windows CMD

```bat
python -m venv .venv
.venv\Scripts\activate.bat
python -m pip install -r backend\requirements.txt
python -m uvicorn app.main:app --app-dir backend --port 8000
```

### macOS / Linux

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
cp backend/.env.example backend/.env   # tùy chọn
python -m uvicorn app.main:app --app-dir backend --port 8000
```

### Cách chạy khác (từ thư mục `backend`)

```powershell
cd backend
python -m uvicorn app.main:app --port 8000
```

Không bắt buộc dùng `uvicorn` trực tiếp: `python -m uvicorn` luôn dùng đúng Python/venv hiện tại và tránh lỗi `'uvicorn' is not recognized`.

Nếu cổng `8000` bận, đổi sang cổng khác:

```powershell
python -m uvicorn app.main:app --app-dir backend --port 8001
```

Sau đó mở <http://localhost:8001>.

---

## 3. Cấu hình (tùy chọn)

File cấu hình là `backend/.env`. Nếu **không tạo file này**, project vẫn chạy với giá trị mặc định và chỉ dùng Bandit.

```ini
# Bật/tắt LLM: 0 = chỉ Bandit, 1 = bật LLM
USE_LLM=1

# OpenAI / OpenRouter / Groq / Together / Ollama / LM Studio
LLM_API_KEY=
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
LLM_TEMPERATURE=0

# Giới hạn
MAX_CODE_LENGTH=20000
BANDIT_TIMEOUT=30
LLM_TIMEOUT=90
```

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `USE_LLM` | `1` | `0` để tắt hoàn toàn LLM |
| `LLM_API_KEY` | rỗng | API key của nhà cung cấp |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | Endpoint OpenAI-compatible |
| `LLM_MODEL` | `gpt-4o-mini` | Tên model |
| `MAX_CODE_LENGTH` | `20000` | Giới hạn ký tự code |
| `BANDIT_TIMEOUT` | `30` | Timeout Bandit (giây) |
| `LLM_TIMEOUT` | `90` | Timeout LLM (giây) |

Một số nhà cung cấp:

| Nhà cung cấp | `LLM_BASE_URL` | Ghi chú |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | Cần API key |
| OpenRouter | `https://openrouter.ai/api/v1` | Nhiều model, có model miễn phí |
| Ollama (local) | `http://localhost:11434/v1` | Miễn phí, không cần key |
| LM Studio (local) | `http://localhost:1234/v1` | Miễn phí, không cần key |

Lưu ý:

- Không có `LLM_API_KEY` (và `LLM_BASE_URL` không phải localhost) thì LLM coi như **chưa cấu hình**. `hybrid` tự fallback về kết quả Bandit và ghi lý do vào `meta.llm_error`; `llm` trả danh sách rỗng kèm `meta.llm_error`.
- Sửa `.env` xong phải **khởi động lại server** (`.env` được đọc lúc khởi động).
- Không commit `backend/.env` — file này đã nằm trong `.gitignore`.

---

## 4. Kiểm tra nhanh sau khi chạy

PowerShell:

```powershell
Invoke-RestMethod http://localhost:8000/health
```

Kết quả mẫu:

```json
{
  "status": "ok",
  "llm_enabled": false,
  "max_code_length": 20000
}
```

Gọi review chế độ chỉ Bandit (không cần API key):

```powershell
$body = @{ code = "import subprocess`nsubprocess.call('ls', shell=True)`n" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://localhost:8000/review?mode=bandit" `
  -ContentType "application/json" -Body $body
```

curl (macOS/Linux/Git Bash):

```bash
curl -X POST "http://localhost:8000/review?mode=bandit" \
  -H "Content-Type: application/json" \
  -d '{"code": "import subprocess\nsubprocess.call(cmd, shell=True)"}'
```

Các endpoint khác:

```bash
# Dữ liệu giả, không cần API key
curl -X POST http://localhost:8000/mock/review \
  -H "Content-Type: application/json" \
  -d '{"code": "x = 1"}'

# Code mẫu cho nút "Tải ví dụ"
curl http://localhost:8000/sample
```

---

## 5. Chạy test

Từ thư mục gốc project:

```powershell
python -m pytest
```

Kết quả mong đợi: **16 passed**.

Có thể chạy trực tiếp trong `backend`:

```powershell
cd backend
python -m pytest tests
```

Cài thêm công cụ dev (tùy chọn):

```powershell
python -m pip install -r backend\requirements-dev.txt
python -m ruff check backend
```

---

## 6. API và các chế độ review

| Method | Path | Mô tả |
|---|---|---|
| `GET` | `/health` | Trạng thái server + `llm_enabled` |
| `GET` | `/sample` | Code Python mẫu |
| `POST` | `/review` | Review thật; chọn `mode=bandit \| llm \| hybrid` |
| `POST` | `/mock/review` | Trả dữ liệu giả, không cần API key |

| `mode` | Chạy gì? | Dùng khi nào |
|---|---|---|
| `bandit` | Chỉ Bandit SAST | Nhanh, không cần API key, đo baseline SAST |
| `llm` | Chỉ LLM | Đo khả năng bắt bug/quality của riêng LLM |
| `hybrid` | Bandit + LLM trong 1 lượt (mặc định) | Chế độ chính, giảm false positive |

`mode` có thể gửi trong body hoặc query (`?mode=...`). Nếu gửi cả hai, **query được ưu tiên**.

Hợp đồng JSON đầy đủ: [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md).

---

## 7. Cấu trúc thư mục

```text
AI-Code-Reviewer/
├── backend/
│   ├── app/
│   │   ├── main.py           # FastAPI: routes, CORS, phục vụ Web UI
│   │   ├── config.py         # Đọc backend/.env
│   │   ├── schemas.py        # Hợp đồng JSON v2
│   │   ├── bandit_runner.py  # Chạy Bandit + chuẩn hóa kết quả
│   │   ├── llm_client.py     # Gọi LLM OpenAI-compatible (1 lượt)
│   │   ├── prompts.py        # Prompt + CWE rubrics
│   │   ├── pipeline.py       # Line Validation + Merge/Dedup + sắp xếp
│   │   └── mock_data.py      # Code mẫu + dữ liệu giả
│   ├── web/                  # Web UI (HTML/CSS/JS + CodeMirror offline)
│   ├── tests/                # 16 unit/contract tests
│   ├── requirements.txt
│   ├── requirements-dev.txt
│   └── .env.example
├── docs/
│   ├── ARCHITECTURE.md
│   ├── API_CONTRACT.md
│   └── HUONG_DAN_NGUOI_1.md
├── Procfile                  # Deploy Railway
├── render.yaml               # Deploy Render
├── pyproject.toml
└── README.md
```

---

## 8. Lỗi thường gặp

| Lỗi | Nguyên nhân | Cách xử lý |
|---|---|---|
| `'uvicorn' is not recognized` | Chưa kích hoạt venv hoặc chưa cài | Dùng `python -m uvicorn ...`, hoặc kích hoạt `.venv` rồi cài lại requirements |
| `ModuleNotFoundError: No module named 'app'` | Chạy sai thư mục | Chạy từ root với `--app-dir backend`, hoặc `cd backend` trước khi chạy |
| `WinError 10048` / port đang bận | Cổng `8000` đã có process khác | Đổi `--port 8001`, hoặc tìm process: `Get-NetTCPConnection -LocalPort 8000` |
| UI báo "Không kết nối được server" | Server chưa chạy hoặc khác cổng | Khởi động server đúng cổng; có thể mở `http://localhost:8000/?api=http://localhost:8001` |
| `LLM: chưa cấu hình` | Thiếu `LLM_API_KEY` hoặc `USE_LLM=0` | Điền key trong `backend/.env` rồi khởi động lại server |
| `LLM timeout` | Mạng chậm / model chậm | Tăng `LLM_TIMEOUT`, kiểm tra `LLM_BASE_URL` |
| HTTP `422` khi gọi `/review` | `mode` không hợp lệ | Chỉ dùng `bandit`, `llm` hoặc `hybrid` |
| PowerShell chặn `Activate.ps1` | Execution Policy | `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` |
| `bandit` không tìm thấy | Chưa cài đúng venv | `python -m pip install bandit` (code cũng tự fallback sang `python -m bandit`) |

---

## 9. Deploy

- **Render**: dùng `render.yaml` — tạo Blueprint từ repo, điền `LLM_API_KEY` nếu cần.
- **Railway**: dùng `Procfile`:

  ```text
  web: uvicorn app.main:app --host 0.0.0.0 --port $PORT --app-dir backend
  ```

CORS đã bật `allow_origins=["*"]` để Chrome Extension gọi trực tiếp.

---

## 10. Quy ước nhóm

- **Hợp đồng JSON chỉ sửa ở một nơi**: `backend/app/schemas.py` — thông báo cả nhóm trước khi đổi.
- **Prompt tách biệt**: chỉ sửa `backend/app/prompts.py`; backend dùng `SYSTEM_PROMPT` và `build_review_prompt()`.
- **Phát triển song song**: dùng `POST /mock/review` thay vì chờ LLM/API key.
- **Bảo mật**: API key nằm trong `backend/.env`, không commit; file tạm dùng cho Bandit được xóa tự động.

Xem thêm: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) · [`docs/HUONG_DAN_NGUOI_1.md`](docs/HUONG_DAN_NGUOI_1.md).
