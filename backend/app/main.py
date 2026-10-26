"""FastAPI app: route chính, CORS, phục vụ Web UI và các endpoint hỗ trợ.

Endpoints:
- GET  /health
- GET  /        -> web/index.html
- GET  /sample   -> code mẫu
- POST /review   -> review thật (mode=bandit | llm | hybrid)
- POST /mock/review -> dữ liệu giả cho team phát triển song song
"""

import logging
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import MAX_CODE_LENGTH, WEB_DIR, llm_is_configured
from .mock_data import SAMPLE_CODE, mock_issues
from .pipeline import review_code
from .schemas import ReviewMode, ReviewRequest, ReviewResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("ai-code-reviewer")

app = FastAPI(
    title="AI Code Reviewer API",
    description="Hybrid SAST (Bandit) + LLM, single-pass adjudication. Hợp đồng JSON v2 dùng chung cả nhóm.",
    version="2.2.0",
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


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    ico = WEB_DIR / "favicon.ico"
    if not ico.exists():
        raise HTTPException(status_code=404, detail="Không tìm thấy favicon.ico")
    return FileResponse(ico)


@app.get("/sample")
def sample():
    return {"code": SAMPLE_CODE}


@app.post("/review", response_model=ReviewResponse)
def review(payload: ReviewRequest, mode: Optional[ReviewMode] = None):
    """Review code. `mode` có thể gửi trong body hoặc query (?mode=...).

    Query có độ ưu tiên cao hơn body để tiện đo đạc bằng script:
    `POST /review?mode=bandit`.
    """
    code = payload.code or ""
    if not code.strip():
        raise HTTPException(status_code=400, detail="Mã nguồn trống.")
    if len(code) > MAX_CODE_LENGTH:
        raise HTTPException(status_code=413, detail=f"Mã nguồn quá dài ({len(code)} > {MAX_CODE_LENGTH} ký tự).")
    try:
        return review_code(code, mode or payload.mode)
    except Exception as exc:
        log.exception("Lỗi khi review")
        raise HTTPException(status_code=500, detail=f"Lỗi nội bộ: {exc}") from exc


@app.post("/mock/review", response_model=ReviewResponse)
def mock_review(payload: ReviewRequest):
    return {
        "issues": mock_issues(),
        "meta": {"mode": "mock", "bandit_count": 0, "llm_count": 0, "dropped_invalid_lines": 0, "merged_count": 0, "llm_error": None},
    }
