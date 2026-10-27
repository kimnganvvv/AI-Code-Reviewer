"""Client gọi LLM theo chuẩn OpenAI-compatible.

Các điểm vào theo kiến trúc 3 tầng (prompt/parser nằm ở layered_prompts.py):
- llm_filter(code, candidates)  -> Tầng 2: phán quyết keep/drop cho từng ứng viên của công cụ (1 lời gọi, theo lô).
- llm_find_gaps(code)           -> Tầng 3: tìm tối đa vài lỗi thuộc 4 loại công cụ không phủ.
- llm_review(...)               -> 1 lượt tự do cũ (prompts.py), chỉ còn dùng cho mode=llm làm mốc so sánh.
- llm_verify_patch(...)         -> re-verification bản vá bằng unit test.

Mọi điểm vào đều tự retry khi JSON hỏng (parse_error) thay vì coi là "code sạch".
- Tuỳ chọn structured output (REVIEW_JSON_SCHEMA) qua biến môi trường LLM_STRUCTURED_OUTPUT.
- llm_verify_patch() dùng prompt re-verification; số test/verdict do code quyết định.

Hỗ trợ OpenAI, OpenRouter, Groq, Together, Ollama, LM Studio, vLLM.
"""

import json
import logging
import os
import re
import time
from typing import List, Optional

import requests

from . import layered_prompts, prompts
from .config import (
    FILTER_CONTEXT_LINES, GAP_MAX_ISSUES, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TEMPERATURE, LLM_TIMEOUT,
)

log = logging.getLogger("ai-code-reviewer")
# Chỉ gửi khi được đặt (Groq/OpenAI model suy luận: low | medium | high). Để trống với Ollama.
LLM_REASONING_EFFORT = os.getenv("LLM_REASONING_EFFORT", "").strip().lower()
# off         : không gửi response_format (mặc định, an toàn với mọi provider)
# json_schema : gửi REVIEW_JSON_SCHEMA (OpenAI, vLLM, Ollama bản mới, một số model OpenRouter/Groq)
# json_object : chỉ ép trả JSON object (provider chỉ hỗ trợ JSON mode)
# Nếu provider từ chối (HTTP 400) client tự gửi lại không kèm response_format.
STRUCTURED_MODE = os.getenv("LLM_STRUCTURED_OUTPUT", "off").strip().lower()
# Số lần gọi lại khi phản hồi không parse được (tổng số lần gọi = 1 + retries)
LLM_PARSE_RETRIES = max(0, int(os.getenv("LLM_PARSE_RETRIES", "1")))
# Trần số token sinh ra (Ollama map sang num_predict). 0 = không giới hạn.
LLM_MAX_TOKENS = max(0, int(os.getenv("LLM_MAX_TOKENS", "5000")))
# Trần token riêng cho từng tầng (đầu ra Tầng 3 rất ngắn, Tầng 2 tỉ lệ với số ứng viên).
FILTER_MAX_TOKENS = max(0, int(os.getenv("FILTER_MAX_TOKENS", "5000")))
GAP_MAX_TOKENS = max(0, int(os.getenv("GAP_MAX_TOKENS", "1500")))
# Giới hạn tốc độ (gói miễn phí hay bị 429 vì TPM = token mỗi phút):
LLM_RATE_LIMIT_RETRIES = max(0, int(os.getenv("LLM_RATE_LIMIT_RETRIES", "4")))  # số lần chờ rồi gọi lại khi 429
LLM_MAX_WAIT = float(os.getenv("LLM_MAX_WAIT", "75"))        # chờ tối đa mỗi lần (giây)
LLM_MIN_INTERVAL = float(os.getenv("LLM_MIN_INTERVAL", "0"))  # khoảng cách tối thiểu giữa 2 lần gọi (giây)
_last_call_ts = 0.0


class LLMError(RuntimeError):
    pass


def _response_format(schema: Optional[dict], name: str) -> Optional[dict]:
    if not schema or STRUCTURED_MODE == "off":
        return None
    if STRUCTURED_MODE == "json_object":
        return {"type": "json_object"}
    if STRUCTURED_MODE == "json_schema":
        return {"type": "json_schema", "json_schema": {"name": name, "strict": True, "schema": schema}}
    return None


def _post(payload: dict) -> requests.Response:
    headers = {"Content-Type": "application/json"}
    if LLM_API_KEY:
        headers["Authorization"] = f"Bearer {LLM_API_KEY}"
    try:
        return requests.post(f"{LLM_BASE_URL}/chat/completions", headers=headers, json=payload, timeout=LLM_TIMEOUT)
    except requests.Timeout as e:
        raise LLMError(f"LLM timeout sau {LLM_TIMEOUT}s") from e
    except requests.RequestException as e:
        raise LLMError(f"Không kết nối được LLM: {e}") from e


_RETRY_IN_RE = re.compile(r"try again in\s*(?:(\d+)m)?\s*([\d.]+)\s*(ms|s)\b", re.I)


def _retry_after_seconds(r: requests.Response) -> Optional[float]:
    """Đọc thời gian cần chờ từ header Retry-After hoặc từ câu 'Please try again in 17.7s'."""
    h = r.headers.get("retry-after") if getattr(r, "headers", None) else None
    if h:
        try:
            return float(h)
        except ValueError:
            pass
    m = _RETRY_IN_RE.search(r.text or "")
    if not m:
        return None
    minutes, value, unit = m.groups()
    secs = float(value) / 1000.0 if unit.lower() == "ms" else float(value)
    return secs + (int(minutes) * 60 if minutes else 0)


def _send(payload: dict) -> requests.Response:
    """_post có giãn cách giữa các lần gọi, chờ-rồi-thử-lại khi 429 và thử lại 1 lần khi rớt kết nối."""
    global _last_call_ts
    conn_retry_left = 1
    attempt = 0
    while True:
        if LLM_MIN_INTERVAL > 0:
            gap = LLM_MIN_INTERVAL - (time.monotonic() - _last_call_ts)
            if gap > 0:
                time.sleep(gap)
        try:
            r = _post(payload)
        except LLMError as e:
            if conn_retry_left and str(e).startswith("Không kết nối"):
                conn_retry_left -= 1
                log.warning("Rớt kết nối LLM, thử lại sau 3s: %s", e)
                time.sleep(3)
                continue
            raise
        finally:
            _last_call_ts = time.monotonic()

        if r.status_code != 429 or attempt >= LLM_RATE_LIMIT_RETRIES:
            return r
        wait = _retry_after_seconds(r)
        wait = min((wait if wait is not None else 10.0 * (attempt + 1)) + 1.0, LLM_MAX_WAIT)
        attempt += 1
        log.warning("LLM 429 (vượt hạn mức): chờ %.1fs rồi thử lại (%s/%s)", wait, attempt, LLM_RATE_LIMIT_RETRIES)
        time.sleep(wait)


def call_llm(
    system_prompt: str,
    user_prompt: str,
    response_schema: Optional[dict] = None,
    schema_name: str = "response",
    *,
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
) -> str:
    """`temperature`/`max_tokens` None = dùng mặc định toàn cục; max_tokens=0 = không giới hạn."""
    token_cap = LLM_MAX_TOKENS if max_tokens is None else max_tokens
    payload = {
        "model": LLM_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": LLM_TEMPERATURE if temperature is None else temperature,
    }
    if token_cap:
        payload["max_tokens"] = token_cap
    if LLM_REASONING_EFFORT:
        payload["reasoning_effort"] = LLM_REASONING_EFFORT
    rf = _response_format(response_schema, schema_name)
    if rf:
        payload["response_format"] = rf

    t0 = time.perf_counter()
    r = _send(payload)
    if r.status_code == 400 and rf:
        log.warning("Provider từ chối response_format (%s); gọi lại không dùng structured output", STRUCTURED_MODE)
        payload.pop("response_format", None)
        r = _send(payload)

    if r.status_code >= 400:
        raise LLMError(f"LLM trả HTTP {r.status_code}: {r.text[:300]}")

    try:
        data = r.json()
        usage = data.get("usage") or {}
        elapsed = time.perf_counter() - t0
        out_tok = usage.get("completion_tokens")
        log.info(
            "LLM %s: %.1fs | prompt_tokens=%s completion_tokens=%s%s",
            LLM_MODEL, elapsed, usage.get("prompt_tokens"), out_tok,
            f" (~{out_tok / elapsed:.1f} tok/s gồm cả prefill)" if out_tok and elapsed > 0 else "",
        )
        choice = data["choices"][0]
        if choice.get("finish_reason") == "length":
            log.warning("LLM bị cắt do đạt max_tokens=%s; JSON có thể thiếu -> tăng trần token", token_cap)
        return choice["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError) as e:
        raise LLMError(f"Phản hồi LLM không đúng định dạng: {e}") from e


# Giữ lại cho các test/script cũ; luồng review mới KHÔNG dùng hàm này.
def extract_json_array(text: str) -> List[dict]:
    if not text:
        return []
    s = text.strip()
    if "```" in s:
        blocks = re.findall(r"```(?:json)?\s*(.*?)```", s, re.S)
        if blocks:
            s = blocks[0].strip()
    i = s.find("[")
    j = s.rfind("]")
    if i == -1 or j == -1 or j < i:
        return []
    snip = s[i:j + 1]
    for cand in (snip, re.sub(r",\s*([\]\}])", r"\1", snip)):
        try:
            parsed = json.loads(cand)
            return parsed if isinstance(parsed, list) else []
        except json.JSONDecodeError:
            continue
    return []


def _call_and_parse(
    system_prompt: str,
    user_prompt: str,
    schema: Optional[dict],
    schema_name: str,
    parse,
    *,
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
) -> dict:
    """Gọi LLM rồi parse; parse_error -> gọi lại tối đa LLM_PARSE_RETRIES lần. `parse(raw)` phải trả dict có khóa
    'parse_error'. Raise LLMError nếu hết lượt mà vẫn không parse được."""
    last_raw = ""
    for attempt in range(1 + LLM_PARSE_RETRIES):
        last_raw = call_llm(system_prompt, user_prompt, schema, schema_name,
                            temperature=temperature, max_tokens=max_tokens)
        result = parse(last_raw)
        if not result["parse_error"]:
            return result
        log.warning("LLM (%s) trả JSON không parse được (lần %s/%s)", schema_name, attempt + 1, 1 + LLM_PARSE_RETRIES)
    raise LLMError(f"LLM trả JSON không hợp lệ sau {1 + LLM_PARSE_RETRIES} lần thử: {last_raw[:200]!r}")


def llm_filter(code: str, candidates: List[dict]) -> dict:
    """Tầng 2: phán quyết keep/drop cho các ứng viên (đã có candidate_id) trong MỘT lời gọi.

    Trả dict của layered_prompts.parse_filter_json(): {verdicts, parse_error, rejected_suggestions}.
    Ứng viên thiếu verdict được điền keep=True + auto_default. Raise LLMError khi hết lượt retry.
    """
    system_prompt, user_prompt = layered_prompts.build_filter_prompt(code, candidates, FILTER_CONTEXT_LINES)
    _, total_lines = prompts.format_code_with_line_numbers(code)
    expected = [c["candidate_id"] for c in candidates]
    return _call_and_parse(
        system_prompt, user_prompt, layered_prompts.FILTER_JSON_SCHEMA, "candidate_filter",
        lambda raw: layered_prompts.parse_filter_json(raw, total_lines, code, expected),
        max_tokens=FILTER_MAX_TOKENS,
    )


def llm_find_gaps(code: str) -> dict:
    """Tầng 3: tìm lỗi thuộc 4 loại công cụ không phủ (chia 0, race, rò rỉ dữ liệu, IDOR).

    Trả dict của layered_prompts.parse_gap_json(): {issues, parse_error, dropped, rejected_suggestions}.
    Raise LLMError khi hết lượt retry.
    """
    system_prompt, user_prompt = layered_prompts.build_gap_prompt(code, GAP_MAX_ISSUES)
    _, total_lines = prompts.format_code_with_line_numbers(code)
    return _call_and_parse(
        system_prompt, user_prompt, layered_prompts.GAP_JSON_SCHEMA, "gap_finder",
        lambda raw: layered_prompts.parse_gap_json(raw, total_lines, code, GAP_MAX_ISSUES),
        max_tokens=GAP_MAX_TOKENS,
    )


def llm_review(code: str, bandit_view: List[dict], system_prompt: str, user_prompt_builder) -> dict:
    """Lượt review tự do cũ (prompts.py): trả dict của prompts.parse_and_validate_llm_json():
    {bandit_verdicts, new_issues, parse_error, dropped_new_issues, rejected_suggestions}.

    Chỉ còn dùng cho mode=llm (mốc so sánh "LLM thuần", không giới hạn loại lỗi, không công cụ).
    bandit_view: cảnh báo Bandit đã đổi sang trường Bandit chuẩn; finding_id B1, B2... theo đúng thứ tự.
    Raise LLMError nếu hết lượt retry mà vẫn không parse được JSON.
    """
    _, total_lines = prompts.format_code_with_line_numbers(code)
    expected_ids = prompts.expected_bandit_ids(bandit_view)
    user_prompt = user_prompt_builder(code, bandit_view)
    return _call_and_parse(
        system_prompt, user_prompt, prompts.REVIEW_JSON_SCHEMA, "code_review",
        lambda raw: prompts.parse_and_validate_llm_json(
            raw, total_lines, code_snippet=code, expected_finding_ids=expected_ids),
    )


def llm_verify_patch(
    original_code: str,
    proposed_patch: str,
    test_output: str,
    defect_description: str = "",
) -> dict:
    """Re-verification bản vá bằng kết quả unit test.

    Số test và verdict do code quyết định khi nhận dạng được tóm tắt pytest/unittest
    (verdict_source='test_runner'). LLM chỉ đóng góp 'defect_addressed' và 'explanation'.
    Nếu LLM lỗi, vẫn trả kết quả xác định từ test runner (defect_addressed='unclear').
    """
    system_prompt, user_prompt = prompts.build_test_reverification_prompt(
        original_code, proposed_patch, test_output, defect_description
    )
    try:
        raw = call_llm(system_prompt, user_prompt, prompts.REVERIFICATION_JSON_SCHEMA, "patch_verification")
    except LLMError as e:
        log.warning("LLM re-verification thất bại, dùng kết quả test runner: %s", e)
        raw = ""
    return prompts.parse_reverification_json(raw, test_output)
