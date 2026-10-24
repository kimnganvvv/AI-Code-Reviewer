"""Client gọi LLM theo chuẩn OpenAI-compatible (1 lượt duy nhất).

Mục đích: giảm ~50% độ trễ và token so với review 2 lượt.
Hỗ trợ OpenAI, OpenRouter, Groq, Together, Ollama, LM Studio.
"""

import json
import re
from typing import List

import requests

from .config import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TEMPERATURE, LLM_TIMEOUT


class LLMError(RuntimeError):
    pass


def call_llm(system_prompt: str, user_prompt: str) -> str:
    headers = {"Content-Type": "application/json"}
    if LLM_API_KEY:
        headers["Authorization"] = f"Bearer {LLM_API_KEY}"

    payload = {
        "model": LLM_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": LLM_TEMPERATURE,
    }

    try:
        r = requests.post(f"{LLM_BASE_URL}/chat/completions", headers=headers, json=payload, timeout=LLM_TIMEOUT)
    except requests.Timeout as e:
        raise LLMError(f"LLM timeout sau {LLM_TIMEOUT}s") from e
    except requests.RequestException as e:
        raise LLMError(f"Không kết nối được LLM: {e}") from e

    if r.status_code >= 400:
        raise LLMError(f"LLM trả HTTP {r.status_code}: {r.text[:300]}")

    try:
        data = r.json()
        return data["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError) as e:
        raise LLMError(f"Phản hồi LLM không đúng định dạng: {e}") from e


def extract_json_array(text: str) -> List[dict]:
    if not text:
        return []
    s = text.strip()

    # Bóc ```json ... ```
    if "```" in s:
        blocks = re.findall(r"```(?:json)?\s*(.*?)```", s, re.S)
        if blocks:
            s = blocks[0].strip()

    i = s.find("[")
    j = s.rfind("]")
    if i == -1 or j == -1 or j < i:
        return []

    snip = s[i:j + 1]
    # Thử parse, nếu lỗi bỏ dấu phẩy thừa
    for cand in (snip, re.sub(r",\s*([\]\}])", r"\1", snip)):
        try:
            parsed = json.loads(cand)
            return parsed if isinstance(parsed, list) else []
        except json.JSONDecodeError:
            continue
    return []


def llm_review(code: str, bandit_issues: List[dict], system_prompt: str, user_prompt_builder) -> List[dict]:
    raw = call_llm(system_prompt, user_prompt_builder(code, bandit_issues))
    return extract_json_array(raw)
