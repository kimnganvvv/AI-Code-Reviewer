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
VALID_MODES = {"bandit", "llm", "hybrid"}


def normalize_mode(mode: str | None) -> str:
    m = (mode or "hybrid").strip().lower()
    return m if m in VALID_MODES else "hybrid"


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


# 3) Chuyển kết quả LLM (contract bandit_verdicts + new_issues) sang Issue
def bandit_view(b_issues: List[dict]) -> List[dict]:
    """Đổi issue Bandit (định dạng Issue + _test_id) sang trường Bandit chuẩn mà prompt mong đợi.

    Bắt buộc có test_id và line_number: BANDIT ADJUDICATION GUIDE trong prompt dựa vào test_id.
    finding_id B1, B2... do prompts.assign_bandit_finding_ids gán theo đúng thứ tự danh sách này.
    """
    view = []
    for b in b_issues:
        view.append({
            "test_id": b.get("_test_id") or b.get("test_id"),
            "line_number": b.get("line") if b.get("line") is not None else b.get("line_number"),
            "issue_text": b.get("message") or b.get("issue_text") or "",
            "issue_severity": str(b.get("severity") or b.get("issue_severity") or "").upper(),
            "issue_confidence": str(b.get("confidence") or b.get("issue_confidence") or "").upper(),
            "cwe_id": b.get("cwe_id"),
        })
    return view


def apply_bandit_verdicts(b_issues: List[dict], verdicts: List[dict]) -> Tuple[List[dict], int]:
    """Áp phán quyết của LLM lên cảnh báo Bandit.

    - keep=false            -> loại (báo động giả), đếm vào suppressed.
    - keep=true             -> giữ, source='both', dùng explanation (và bản vá hợp lệ) của LLM.
    - không có verdict / auto_default -> giữ nguyên source='bandit' (an toàn hơn là bỏ sót).
    Bản vá chỉ được nhận khi khoảng dòng của nó bao trùm dòng Bandit báo.
    """
    by_id = {v.get("finding_id"): v for v in verdicts or []}
    kept: List[dict] = []
    suppressed = 0
    for idx, b in enumerate(b_issues, start=1):
        item = dict(b)
        item.setdefault("end_line", item.get("line"))
        v = by_id.get(f"B{idx}")
        if v is None or v.get("auto_default"):
            kept.append(item)
            continue
        if not v.get("keep", True):
            suppressed += 1
            continue

        item["source"] = "both"
        if v.get("explanation"):
            item["explanation"] = v["explanation"]
        sug, v_line, v_end, b_line = v.get("suggestion"), v.get("line"), v.get("end_line"), item.get("line")
        if sug and v_line is not None and v_end is not None and b_line is not None and v_line <= b_line <= v_end:
            item["suggestion"] = sug
            item["line"], item["end_line"] = v_line, v_end
        kept.append(item)
    return kept, suppressed


def new_issue_to_issue(n: dict) -> dict:
    """new_issue đã validate -> dict đúng schema Issue (source='llm')."""
    cwe = n.get("cwe_id")
    if not cwe or str(cwe).upper() == "N/A":
        cwe = None
    return {
        "line": n["line"],
        "end_line": n.get("end_line") or n["line"],
        "type": n["type"],
        "severity": n["severity"],
        "confidence": n["confidence"],
        "cwe_id": cwe,
        "message": n["message"],
        "explanation": n["explanation"],
        "suggestion": n.get("suggestion") or "",
        "source": "llm",
    }


# 4) Entry point: chạy theo 1 trong 3 chế độ đo
def review_code(code: str, mode: str = "hybrid") -> dict:
    """Review code theo chế độ `bandit`, `llm` hoặc `hybrid`.

    - bandit : chỉ chạy SAST, không gọi LLM (nhanh, rẻ, ít false positive logic).
    - llm    : chỉ gọi LLM, không chạy Bandit (dùng để đo khả năng thuần LLM).
    - hybrid : chạy Bandit rồi nhúng kết quả vào 1 lượt LLM; LLM phán quyết từng cảnh báo
               Bandit (bandit_verdicts) và báo thêm lỗi Bandit bỏ sót (new_issues).

    Nếu LLM lỗi ở chế độ hybrid, vẫn trả kết quả Bandit thô (source='bandit') kèm meta.llm_error.
    """
    mode = normalize_mode(mode)
    b_issues: List[dict] = []
    l_issues: List[dict] = []
    l_err = None
    suppressed = 0
    rejected = 0
    llm_dropped = 0

    if mode in ("bandit", "hybrid"):
        b_issues = run_bandit(code)
    bandit_total = len(b_issues)

    if mode in ("llm", "hybrid"):
        if llm_is_configured():
            try:
                result = llm_review(code, bandit_view(b_issues), prompts.SYSTEM_PROMPT, prompts.build_review_prompt)
                if b_issues:
                    b_issues, suppressed = apply_bandit_verdicts(b_issues, result["bandit_verdicts"])
                l_issues = [new_issue_to_issue(n) for n in result["new_issues"]]
                rejected = result.get("rejected_suggestions", 0)
                llm_dropped = result.get("dropped_new_issues", 0)  # ảo giác dòng/evidence đã bị parser loại
            except LLMError as e:
                l_err = str(e)
                log.warning("LLM thất bại (mode=%s): %s", mode, e)
            except Exception as e:  # noqa
                l_err = f"{type(e).__name__}: {e}"
                log.warning("Lỗi không mong đợi khi gọi LLM (mode=%s): %s", mode, e)
        else:
            l_err = "LLM chưa cấu hình (thiếu LLM_API_KEY hoặc USE_LLM=0)"

    all_issues = b_issues + l_issues
    valid, dropped = validate_lines(all_issues, code)
    dropped += llm_dropped
    merged, mcount = merge_duplicates(valid)

    # Cùng dòng: mức nghiêm trọng cao xếp trước
    merged.sort(key=lambda x: (x.get("line", 0), -SEV_RANK.get(x.get("severity"), 0)))
    return {
        "issues": merged,
        "meta": {
            "mode": mode,
            "bandit_count": bandit_total,
            "llm_count": len(l_issues),
            "dropped_invalid_lines": dropped,
            "merged_count": mcount,
            "llm_error": l_err,
            "suppressed_count": suppressed,
            "rejected_suggestions": rejected,
        },
    }