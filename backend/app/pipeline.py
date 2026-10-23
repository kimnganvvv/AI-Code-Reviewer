"""Pipeline chính: Bandit -> LLM (1 lượt) -> Line Validation -> Merge/Dedup -> sắp xếp.

Thứ tự này bám sát luồng xử lý trong đề tài và đáp ứng yêu cầu file Word.
"""

import logging
import re
from typing import List, Tuple

from . import prompts
from .bandit_runner import run_bandit
from .config import llm_is_configured
from .llm_client import LLMError, llm_review

log = logging.getLogger("ai-code-reviewer")

SEV_RANK = {"low": 1, "medium": 2, "high": 3}
VALID_TYPE = {"security", "bug", "quality"}
VALID_SEV = {"high", "medium", "low"}


# 1) Line Validation: loại số dòng bịa đặt do ảo giác LLM
def validate_lines(issues: List[dict], code: str) -> Tuple[List[dict], int]:
    total = len(code.splitlines())
    if total == 0:
        return [], len(issues)
    kept, dropped = [], 0
    for it in issues:
        line = it.get("line")
        if isinstance(line, int) and 1 <= line <= total:
            kept.append(it)
        else:
            dropped += 1
            log.debug("Loại issue dòng không hợp lệ: %s (tổng %s dòng)", line, total)
    return kept, dropped


# 2) Merge/Dedup: gộp trùng giữa Bandit và LLM
def _is_similar(a: dict, b: dict) -> bool:
    la, lb = a.get("line"), b.get("line")
    if la is None or lb is None:
        return False

    src_a = a.get("_srcs") or {a.get("source")}
    if b.get("source") in src_a:
        # Cùng nguồn: chỉ gộp khi cùng định danh
        if b.get("source") == "bandit":
            return b.get("_test_id") in (a.get("_tests") or set()) and la == lb
        # LLM vs LLM: chỉ gộp nếu cùng cwe_id và cùng dòng
        if a.get("cwe_id") and a.get("cwe_id") == b.get("cwe_id") and la == lb:
            return True
        return False

    # Khác nguồn: Bandit vs LLM
    if a.get("cwe_id") and a.get("cwe_id") == b.get("cwe_id") and abs(la - lb) <= 1:
        return True
    if la != lb:
        return False
    if a.get("type") == b.get("type") and a.get("type") in ("security", "bug"):
        return True
    wa = set(re.findall(r"[a-z]{4,}", (a.get("message") or "").lower()))
    wb = set(re.findall(r"[a-z]{4,}", (b.get("message") or "").lower()))
    if wa and wb:
        return (len(wa & wb) / len(wa | wb)) >= 0.4
    return False


def merge_duplicates(issues: List[dict]) -> Tuple[List[dict], int]:
    merged: List[dict] = []
    mcount = 0

    for it in issues:
        target = None
        for ex in merged:
            if _is_similar(ex, it):
                target = ex
                break
        if target is None:
            n = dict(it)
            n["_srcs"] = {it.get("source", "llm")}
            n["_tests"] = {it["_test_id"]} if it.get("_test_id") else set()
            merged.append(n)
            continue

        mcount += 1
        target["source"] = "both"
        target["_srcs"].add(it.get("source", "llm"))
        if it.get("_test_id"):
            target["_tests"].add(it["_test_id"])

        # Ưu tiên giữ thông tin đầy đủ hơn
        if len(it.get("explanation") or "") > len(target.get("explanation") or ""):
            target["explanation"] = it["explanation"]
        if len(it.get("message") or "") > len(target.get("message") or ""):
            target["message"] = it["message"]
        if it.get("suggestion") and not target.get("suggestion"):
            target["suggestion"] = it["suggestion"]
        if not target.get("cwe_id") and it.get("cwe_id"):
            target["cwe_id"] = it["cwe_id"]

        # severity/confidence lấy cao hơn
        if SEV_RANK.get(it.get("severity"), 0) > SEV_RANK.get(target.get("severity"), 0):
            target["severity"] = it["severity"]
        if SEV_RANK.get(it.get("confidence"), 0) > SEV_RANK.get(target.get("confidence"), 0):
            target["confidence"] = it["confidence"]

    for x in merged:
        x.pop("_srcs", None)
        x.pop("_tests", None)
        x.pop("_test_id", None)
    return merged, mcount


# 3) Chuẩn hóa output LLM
def sanitize_llm_issues(raw: List[dict] | None) -> List[dict]:
    clean: List[dict] = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        try:
            line = int(item.get("line"))
        except (TypeError, ValueError):
            line = 0

        t = str(item.get("type", "quality")).lower().strip()
        if t not in VALID_TYPE:
            t = "quality"
        sev = str(item.get("severity", "medium")).lower().strip()
        if sev not in VALID_SEV:
            sev = "medium"
        conf = str(item.get("confidence", "low")).lower().strip()
        if conf not in VALID_SEV:
            conf = "low"
        src = str(item.get("source", "llm")).lower().strip()
        if src not in ("bandit", "llm", "both"):
            src = "llm"
        cwe = item.get("cwe_id")
        if cwe is not None:
            cwe = str(cwe).strip() or None

        clean.append({
            "line": line,
            "type": t,
            "severity": sev,
            "confidence": conf,
            "cwe_id": cwe,
            "message": str(item.get("message", "")).strip(),
            "explanation": str(item.get("explanation", "")).strip(),
            "suggestion": str(item.get("suggestion", "")).strip(),
            "source": src,
        })
    return clean


# 4) Entry point
def review_code(code: str) -> dict:
    b_issues = run_bandit(code)
    l_issues: List[dict] = []
    l_err = None
    mode = "bandit-only"

    if llm_is_configured():
        try:
            raw = llm_review(code, b_issues, prompts.SYSTEM_PROMPT, prompts.build_review_prompt)
            l_issues = sanitize_llm_issues(raw)
            mode = "bandit+llm"
        except LLMError as e:
            l_err = str(e)
            log.warning("LLM thất bại, dùng chế độ bandit-only: %s", e)
        except Exception as e:  # noqa
            l_err = f"{type(e).__name__}: {e}"
            log.warning("Lỗi không mong đợi khi gọi LLM: %s", e)
    else:
        l_err = "LLM chưa cấu hình (thiếu LLM_API_KEY hoặc USE_LLM=0)"

    all_issues = b_issues + l_issues
    valid, dropped = validate_lines(all_issues, code)
    merged, mcount = merge_duplicates(valid)

    merged.sort(key=lambda x: (x.get("line", 0), SEV_RANK.get(x.get("severity"), 9)))
    return {"issues": merged, "meta": {"mode": mode, "bandit_count": len(b_issues), "llm_count": len(l_issues), "dropped_invalid_lines": dropped, "merged_count": mcount, "llm_error": l_err}}
