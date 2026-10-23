"""Cấu hình runtime của backend, đọc từ file `.env` (xem `.env.example`).

Toàn bộ biến môi trường nằm ở đây để đổi model / giới hạn / API key mà không
phải sửa code. Khi deploy lên Render/Railway chỉ cần set biến trên dashboard.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent  # thư mục backend/
load_dotenv(BASE_DIR / ".env")

# Giới hạn
MAX_CODE_LENGTH = int(os.getenv("MAX_CODE_LENGTH", "20000"))  # số ký tự
BANDIT_TIMEOUT = int(os.getenv("BANDIT_TIMEOUT", "30"))  # giây
LLM_TIMEOUT = int(os.getenv("LLM_TIMEOUT", "90"))  # giây

# LLM (chuẩn OpenAI-compatible: OpenAI / OpenRouter / Groq / Ollama / LM Studio)
USE_LLM = os.getenv("USE_LLM", "1") == "1"
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "https://api.openai.com/v1").rstrip("/")
LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")
LLM_TEMPERATURE = float(os.getenv("LLM_TEMPERATURE", "0"))

# Đường dẫn
WEB_DIR = BASE_DIR / "web"
STATIC_DIR = WEB_DIR / "static"


def llm_is_configured() -> bool:
    """LLM chỉ chạy khi có API key, hoặc khi trỏ về model chạy local.

    Ollama / LM Studio không cần key nên coi như đã cấu hình để demo offline
    vẫn chạy được.
    """
    if not USE_LLM:
        return False
    if LLM_API_KEY:
        return True
    return any(host in LLM_BASE_URL for host in ("localhost", "127.0.0.1"))
