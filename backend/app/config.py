"""Cấu hình runtime của backend, đọc từ file `.env` (xem `.env.example`).

Toàn bộ biến môi trường nằm ở đây để đổi model / giới hạn / API key mà không
phải sửa code. Khi deploy lên Render/Railway chỉ cần set biến trên dashboard.
"""

import os
from pathlib import Path
from typing import List

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent  # thư mục backend/
load_dotenv(BASE_DIR / ".env")


def _csv(name: str, default: str) -> List[str]:
    return [x.strip() for x in os.getenv(name, default).split(",") if x.strip()]


# Giới hạn
MAX_CODE_LENGTH = int(os.getenv("MAX_CODE_LENGTH", "20000"))  # số ký tự
BANDIT_TIMEOUT = int(os.getenv("BANDIT_TIMEOUT", "30"))  # giây
LLM_TIMEOUT = int(os.getenv("LLM_TIMEOUT", "90"))  # giây

# ---------------------------------------------------------------------------
# Tầng 1: công cụ xác định (không LLM)
# ---------------------------------------------------------------------------
# Bandit lo bảo mật. Ruff chỉ chọn nhóm bug/quality; KHÔNG bật nhóm "S" vì đó là bản port của
# Bandit (sẽ cho ứng viên trùng và tốn token ở Tầng 2).
USE_RUFF = os.getenv("USE_RUFF", "1") == "1"
RUFF_TIMEOUT = int(os.getenv("RUFF_TIMEOUT", "30"))  # giây
RUFF_SELECT = _csv("RUFF_SELECT", "F,B,SIM,C901,PLR0911,PLR0912,PLR0913,PLR0915")
RUFF_IGNORE = _csv("RUFF_IGNORE", "B008,B904,SIM108,SIM300,F403,F405")
RUFF_MAX_COMPLEXITY = int(os.getenv("RUFF_MAX_COMPLEXITY", "15"))  # C901
RUFF_MAX_ARGS = int(os.getenv("RUFF_MAX_ARGS", "7"))  # PLR0913
RUFF_MAX_BRANCHES = int(os.getenv("RUFF_MAX_BRANCHES", "15"))  # PLR0912
RUFF_MAX_RETURNS = int(os.getenv("RUFF_MAX_RETURNS", "6"))  # PLR0911
RUFF_MAX_STATEMENTS = int(os.getenv("RUFF_MAX_STATEMENTS", "60"))  # PLR0915

# Bộ phát hiện tự viết (dựa trên `ast`): độ sâu lồng và hàm trùng lặp.
USE_STATIC = os.getenv("USE_STATIC", "1") == "1"
STATIC_MAX_NESTING = int(os.getenv("STATIC_MAX_NESTING", "4"))  # báo khi lồng > giá trị này
STATIC_MIN_DUP_STMTS = int(os.getenv("STATIC_MIN_DUP_STMTS", "4"))  # hàm trùng phải có >= N câu lệnh
STATIC_MIN_DUP_BLOCK = int(os.getenv("STATIC_MIN_DUP_BLOCK", "3"))  # khối lặp một phần phải có >= N câu lệnh liên tiếp (DUP002)

# ---------------------------------------------------------------------------
# Tầng 2: LLM làm bộ lọc ứng viên
# ---------------------------------------------------------------------------
FILTER_CONTEXT_LINES = int(os.getenv("FILTER_CONTEXT_LINES", "15"))  # ±N dòng quanh mỗi ứng viên
FILTER_MAX_CANDIDATES = int(os.getenv("FILTER_MAX_CANDIDATES", "30"))  # trần số ứng viên gửi LLM mỗi file

# ---------------------------------------------------------------------------
# Tầng 3: LLM tìm lỗ hổng còn thiếu (giới hạn chặt)
# ---------------------------------------------------------------------------
USE_GAP_LAYER = os.getenv("USE_GAP_LAYER", "1") == "1"
GAP_MAX_ISSUES = int(os.getenv("GAP_MAX_ISSUES", "3"))  # tối đa lỗi mỗi file

# ---------------------------------------------------------------------------
# LLM (chuẩn OpenAI-compatible: OpenAI / OpenRouter / Groq / Ollama / LM Studio)
# ---------------------------------------------------------------------------
USE_LLM = os.getenv("USE_LLM", "1") == "1"
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "https://api.openai.com/v1").rstrip("/")
LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")
LLM_TEMPERATURE = float(os.getenv("LLM_TEMPERATURE", "0"))

# Đường dẫn
WEB_DIR = BASE_DIR / "web"


def llm_is_configured() -> bool:
    """LLM chỉ chạy khi có API key, hoặc khi trỏ về model chạy local.

    Ollama / LM Studio không cần key nên coi như đã cấu hình để demo offline
    vẫn chạy được.
    """
    if not USE_LLM:
        return False
    if LLM_API_KEY:
        return True
    return any(host in LLM_BASE_URL for host in ("localhost", "127.0.0.1", "host.docker.internal"))
