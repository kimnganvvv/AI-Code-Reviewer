# AI Code Reviewer — Agent Instructions

## Quick Start
```powershell
# From repo root
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r backend\requirements.txt
python -m pip install -r backend\requirements-dev.txt  # optional: ruff, mypy
Copy-Item .\backend\.env.example .\backend\.env       # optional
python -m uvicorn app.main:app --app-dir backend --port 8000
```

## Key Commands
| Task | Command |
|------|---------|
| Run tests (16 tests) | `python -m pytest` |
| Lint | `python -m ruff check backend` |
| Type check | `python -m mypy backend/app` |
| Run server | `python -m uvicorn app.main:app --app-dir backend --port 8000` |
| Run from backend/ | `cd backend; python -m uvicorn app.main:app --port 8000` |

## Architecture
- **Backend**: FastAPI in `backend/app/` — single-pass hybrid SAST (Bandit) + LLM
- **Web UI**: Static files in `backend/web/` — no Node.js/build step
- **Extension**: Chrome MV3 in `extension/` — calls `/review` directly
- **Benchmark**: `benchmark/` — precision/recall measurement scripts

## Module Map (`backend/app/`)
| File | Responsibility |
|------|----------------|
| `main.py` | Routes, CORS, static file serving, error handling |
| `schemas.py` | **JSON contract v2 (Pydantic)** — only place to change response shape |
| `config.py` | Reads `backend/.env`, detects local LLM (Ollama/LM Studio) |
| `bandit_runner.py` | Runs Bandit, maps test_id → CWE, quick-fix hints |
| `llm_client.py` | OpenAI-compatible client, JSON extraction, safe error handling |
| `prompts.py` | SYSTEM_PROMPT + `build_review_prompt()` — only prompt logic here |
| `pipeline.py` | Orchestration: Line Validation, Merge/Dedup, sanitize, `review_code()` |
| `mock_data.py` | Sample code + mock issues for `/mock/review` |

## Review Modes
| Mode | Bandit | LLM | Use Case |
|------|--------|-----|----------|
| `bandit` | ✅ | ❌ | Baseline SAST, no API key |
| `llm` | ❌ | ✅ | Pure LLM capability |
| `hybrid` | ✅ | ✅ | Default — adjudicates FP + finds missed bugs |

- `mode` accepted in body **or** query (`?mode=bandit`); **query wins**
- If LLM not configured: `hybrid` falls back to Bandit + `meta.llm_error`; `llm` returns empty issues + `meta.llm_error`

## JSON Contract (v2)
Defined **only in `backend/app/schemas.py`**. 10 required fields per Issue:
```json
{"line":1,"type":"security|bug|quality","severity":"high|medium|low",
 "confidence":"high|medium|low","cwe_id":"CWE-89|null","message":"",
 "explanation":"","suggestion":"","source":"bandit|llm|both"}
```
- `meta.mode` reflects requested mode: `bandit` | `llm` | `hybrid` | `mock`

## Config (`.env`)
```
USE_LLM=1
LLM_API_KEY=
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
MAX_CODE_LENGTH=20000
BANDIT_TIMEOUT=30
LLM_TIMEOUT=90
```
- No `.env` = runs with defaults (Bandit only)
- **Restart server after editing `.env`**
- Local LLMs auto-detected (Ollama `http://localhost:11434/v1`, LM Studio `http://localhost:1234/v1`)

## Testing
```powershell
python -m pytest                    # all tests (16 passed)
python -m pytest backend/tests      # same from root
cd backend; python -m pytest tests  # from backend/
```
- `test_pipeline.py`: unit tests for Line Validation, Merge/Dedup, sanitize, mode logic
- `test_contract.py`: API contract tests (10-field validation, mode handling, errors)

## Lint / Type Check
```powershell
python -m ruff check backend        # 35 warnings (mostly typing.List → list, Optional → X|None)
python -m mypy backend/app          # 5 errors (dict get with Any|None keys)
```
- Run both before committing

## Deploy
- **Render**: `render.yaml` — Blueprint, set `LLM_API_KEY` in dashboard
- **Railway**: `Procfile` — `web: uvicorn app.main:app --host 0.0.0.0 --port $PORT --app-dir backend`
- CORS: `allow_origins=["*"]` for Chrome Extension

## Conventions
- **Contract changes**: only `schemas.py` — notify team first
- **Prompt changes**: only `prompts.py`
- **Parallel dev**: use `POST /mock/review` (no API key needed)
- **Security**: API key in `.env` (gitignored), temp files auto-cleaned
- **No `--reload`** by default — server only runs when explicitly started

## Common Issues
| Error | Fix |
|-------|-----|
| `'uvicorn' not recognized` | Use `python -m uvicorn ...` or activate venv |
| `ModuleNotFoundError: app` | Run from root with `--app-dir backend` or `cd backend` first |
| Port 8000 busy | Use `--port 8001` |
| LLM not configured | Set `LLM_API_KEY` in `.env`, restart server |
| `422` on `/review` | `mode` must be `bandit`, `llm`, or `hybrid` |

## Phần Người 2: extension/ và benchmark/ (QUY TẮC RIÊNG)

- Nhánh làm việc: feature/person2-extension-benchmark. Không commit vào main.
- Chỉ được sửa trong extension/ và benchmark/. KHÔNG sửa backend/, backend/app/prompts.py, docs/API_CONTRACT.md. Nếu cần họ đổi, báo lại thay vì tự sửa.
- Các lệnh Lint/Type check ở trên CHỈ áp dụng cho backend/. Không chạy mypy sửa backend, không sửa 35 cảnh báo ruff của backend.
- Với phần của mình: `python -m ruff check benchmark` phải sạch (dùng --fix nếu cần).
- Test của benchmark: `cd benchmark; python -m pytest` (22 test). Chạy `python -m pytest` ở gốc sẽ chạy cả backend/tests và benchmark/tests (tổng 38).
- Extension: Chrome MV3, JS thuần, không bundler. Dữ liệu từ LLM luôn gán bằng textContent, không dùng innerHTML. Màu thẻ lỗi lấy từ backend/web/index.html để đồng bộ.
- API: POST /review?mode=bandit|llm|hybrid trả {"issues": [...], "meta": {...}}. meta.llm_error có nghĩa kết quả LLM/hybrid KHÔNG hợp lệ để đo.
- Benchmark chấm theo type + số dòng (dung sai ±2, also_lines, end_line); CWE không bắt buộc. Không sửa matching.py hay metrics.py nếu không được yêu cầu.
- Đọc file hiện có trước khi sửa, không ghi đè mà không báo. Kết thúc mỗi tác vụ: liệt kê file đã đổi, lệnh kiểm tra đã chạy và kết quả.