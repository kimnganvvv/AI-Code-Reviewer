# AI Code Reviewer

Trợ lý đánh giá chất lượng và an toàn mã nguồn Python. Hệ thống kết hợp **Bandit SAST** với **LLM** theo hướng **Single-pass Hybrid** (thẩm định + bổ sung lỗi trong **1 lượt** gọi), có cơ chế lọc dòng ảo giác, gộp trùng và hợp đồng JSON chung cho cả nhóm.

## 1. Kiến trúc nhanh

```
Web UI / Chrome Extension (Người 2)
                │  POST /review
                ▼
            FastAPI (Người 1)
           ┌─────────────┐
           │  Bandit SAST │
           └─────┬───────┘
                 │  nhúng kết quả
                 ▼
            LLM (1 lượt)  ← prompt do Người 3 cung cấp
                 │
                 ▼
           Pipeline: Line Validation → Merge/Dedup → Sort
                 │
                 ▼
              JSON v2 (10 trường)
```

Xem chi tiết: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md)

## 2. Cấu trúc thư mục

```
AI-Code-Reviewer/
├── backend/
│   ├── app/
│   │   ├── main.py           # FastAPI: routes, CORS, phục vụ web
│   │   ├── config.py         # Đọc .env
│   │   ├── schemas.py        # Hợp đồng JSON v2 (chỉ sửa tại đây khi đổi hợp đồng)
│   │   ├── bandit_runner.py  # Chạy Bandit + chuẩn hóa
│   │   ├── llm_client.py     # Gọi LLM OpenAI-compatible (1 lượt)
│   │   ├── prompts.py        # Prompt của Người 3 (chỉ 2 điểm móc với backend)
│   │   ├── pipeline.py       # Line Validation + Merge/Dedup + sắp xếp
│   │   └── mock_data.py      # Dữ liệu giả / code mẫu
│   ├── web/
│   │   ├── index.html        # Giao diện 2 cột
│   │   └── static/
│   │       ├── css/app.css
│   │       ├── js/app.js
│   │       └── vendor/       # CodeMirror offline
│   ├── tests/                # Unit test cơ bản
│   ├── requirements.txt
│   └── .env.example
├── docs/
│   ├── ARCHITECTURE.md
│   ├── API_CONTRACT.md
│   └── HUONG_DAN_NGUOI_1.md
├── Procfile
├── render.yaml
└── README.md
```

## 3. Chạy local (5 phút)

```bash
# 1) Cài deps
pip install -r backend/requirements.txt

# 2) Tạo .env
# Windows
copy backend\.env.example backend\.env
# macOS/Linux
cp backend/.env.example backend/.env

# 3) Chạy server (phải chạy trong thư mục backend/)
cd backend
uvicorn app.main:app --reload --port 8000

# Hoặc chạy từ root repo
# uvicorn app.main:app --app-dir backend --reload --port 8000
```

Mở: [http://localhost:8000](http://localhost:8000) · [http://localhost:8000/docs](http://localhost:8000/docs)

> Không có `LLM_API_KEY` cũng chạy được — hệ thống sẽ dùng **Bandit-only** và hiện cảnh báo trong `meta.llm_error`.

## 4. Endpoint chính

| Method | Path | Mô tả |
|---|---|---|
| `GET` | `/health` | Trạng thái server + `llm_enabled` |
| `GET` | `/sample` | Code Python mẫu cho nút "Tải ví dụ" |
| `POST` | `/review` | Review thật (Bandit + LLM nếu cấu hình) |
| `POST` | `/mock/review` | Mock API — trả dữ liệu giả, không cần API key (dùng cho Người 2 & 3) |

Xem hợp đồng đầy đủ tại [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md).

## 5. Cấu hình LLM

Cấu hình trong `backend/.env`:

```ini
USE_LLM=1
LLM_API_KEY=sk-...
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
```

| Nhà cung cấp | `LLM_BASE_URL` | Ghi chú |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | Cần API key |
| OpenRouter | `https://openrouter.ai/api/v1` | Nhiều model, có model free |
| Ollama (local) | `http://localhost:11434/v1` | Miễn phí, không cần key |
| LM Studio (local) | `http://localhost:1234/v1` | Miễn phí, không cần key |

## 6. Deploy

- **Render**: dùng `render.yaml` — Blueprint → chọn repo, điền `LLM_API_KEY` nếu cần.
- **Railway**: dùng `Procfile` (`web: uvicorn app.main:app --host 0.0.0.0 --port $PORT --app-dir backend`).

CORS đã bật `allow_origins=["*"]` để Chrome Extension (Người 2) gọi trực tiếp.

## 7. Kiểm tra nhanh

```bash
curl -X POST http://localhost:8000/review \
  -H "Content-Type: application/json" \
  -d '{"code": "import subprocess\nsubprocess.call(cmd, shell=True)"}'

curl -X POST http://localhost:8000/mock/review \
  -H "Content-Type: application/json" \
  -d '{"code": "x = 1"}'
```

## 8. Nguyên tắc nhóm

- **Hợp đồng chỉ có 1 nơi**: thay đổi `backend/app/schemas.py` và thông báo cả nhóm trước.
- **Prompt tách biệt**: Người 3 chỉ sửa `backend/app/prompts.py`, backend chỉ dùng `SYSTEM_PROMPT` và `build_review_prompt()`.
- **Phát triển song song**: dùng `POST /mock/review` thay vì chờ LLM/key.
- **Bảo mật**: key nằm trong `.env`, không commit; code tạm chạy Bandit được xóa tự động.
