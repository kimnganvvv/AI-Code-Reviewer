"""FastAPI app: route chính, CORS, phục vụ Web UI và các endpoint hỗ trợ.

Endpoints:
- GET  /health
- GET  /        -> web/index.html
- GET  /sample   -> code mẫu
- POST /review   -> review thật (Bandit + LLM nếu cấu hình)
- POST /mock/review -> dữ liệu giả cho team phát triển song song
"""

import logging

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import MAX_CODE_LENGTH, WEB_DIR, llm_is_configured
from .mock_data import SAMPLE_CODE, mock_issues
from .pipeline import review_code
from .schemas import ReviewRequest, ReviewResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("ai-code-reviewer")

app = FastAPI(
    title="AI Code Reviewer API",
    description="Hybrid SAST (Bandit) + LLM, single-pass adjudication. Hợp đồng JSON v2 dùng chung cả nhóm.",
    version="2.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Phục vụ tĩnh: CodeMirror, CSS, JS
if WEB_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(WEB_DIR / "static")), name="static")


@app.get("/health")
def health():
    return {"status": "ok", "llm_enabled": llm_is_configured(), "max_code_length": MAX_CODE_LENGTH}


@app.get("/", include_in_schema=False)
def index():
    idx = WEB_DIR / "index.html"
    if not idx.exists():
        raise HTTPException(status_code=404, detail="Không tìm thấy web/index.html")
    return FileResponse(idx)


@app.get("/sample")
def sample():
    return {"code": SAMPLE_CODE}


@app.post("/review", response_model=ReviewResponse)
def review(payload: ReviewRequest):
    code = payload.code or ""
    if not code.strip():
        raise HTTPException(status_code=400, detail="Mã nguồn trống.")
    if len(code) > MAX_CODE_LENGTH:
        raise HTTPException(status_code=413, detail=f"Mã nguồn quá dài ({len(code)} > {MAX_CODE_LENGTH} ký tự).")
    try:
        return review_code(code)
    except Exception as exc:
        log.exception("Lỗi khi review")
        raise HTTPException(status_code=500, detail=f"Lỗi nội bộ: {exc}") from exc


@app.post("/mock/review", response_model=ReviewResponse)
def mock_review(payload: ReviewRequest):
    return {
        "issues": mock_issues(),
        "meta": {"mode": "mock", "bandit_count": 0, "llm_count": 0, "dropped_invalid_lines": 0, "merged_count": 0, "llm_error": None},
    }
