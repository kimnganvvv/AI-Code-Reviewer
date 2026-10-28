"""Pipeline 3 tầng: công cụ -> LLM lọc -> LLM tìm phần thiếu -> kiểm tra dòng -> sắp xếp.

    Tầng 1 (xác định, không LLM): Bandit (bảo mật) + Ruff (bug/quality) + static (độ sâu lồng, hàm trùng)
                                  -> danh sách ứng viên, khử trùng giữa các công cụ.
    Tầng 2 (LLM làm bộ lọc)     : MỘT lời gọi theo lô; mỗi ứng viên + code ±N dòng -> keep/drop + bản vá.
    Tầng 3 (LLM tìm phần thiếu) : chỉ 4 loại công cụ không phủ (chia 0, race, rò rỉ dữ liệu, IDOR);
                                  evidence bắt buộc và do code kiểm tra; tối đa GAP_MAX_ISSUES lỗi mỗi file.

Các chế độ (để đo ablation từng tầng):
    bandit : chỉ Bandit, không LLM                  tools  : Tầng 1 đầy đủ, không LLM
    filter : Tầng 1 + Tầng 2                        hybrid : Tầng 1 + 2 + 3 (mặc định)
    llm    : 1 lượt LLM tự do, không công cụ (mốc so sánh LLM thuần)
"""

import logging

from . import prompts
from .candidates import (
    SEV_RANK,
    apply_filter_verdicts,
    candidate_to_issue,
    collect_candidates,
    drop_overlapping_gaps,
    fallback_candidates,
    split_for_filter,
)
from .config import FILTER_MAX_CANDIDATES, USE_GAP_LAYER, llm_is_configured
from .llm_client import LLMError, llm_filter, llm_find_gaps, llm_review

log = logging.getLogger("ai-code-reviewer")

VALID_MODES = {"bandit", "tools", "llm", "filter", "hybrid"}
LLM_NOT_CONFIGURED = "LLM chưa cấu hình (thiếu LLM_API_KEY hoặc USE_LLM=0)"


def normalize_mode(mode: str | None) -> str:
    m = (mode or "hybrid").strip().lower()
    return m if m in VALID_MODES else "hybrid"


# Line Validation: lưới an toàn cuối cùng (số dòng của công cụ vốn đúng, của LLM đã qua parser)
def validate_lines(issues: list[dict], code: str) -> tuple[list[dict], int]:
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


# ---------------------------------------------------------------------------
# Chuyển kết quả LLM -> Issue
# ---------------------------------------------------------------------------
def gap_to_issue(g: dict) -> dict:
    """Lỗi Tầng 3 đã validate -> dict đúng schema Issue (source='llm', rule_id=category)."""
    return {
        "line": g["line"],
        "end_line": g.get("end_line") or g["line"],
        "type": g["type"],
        "severity": g["severity"],
        "confidence": g["confidence"],
        "cwe_id": g["cwe_id"],
        "message": g["message"],
        "explanation": g["explanation"],
        "suggestion": g.get("suggestion") or "",
        "source": "llm",
        "rule_id": g.get("category"),
    }


def new_issue_to_issue(n: dict) -> dict:
    """new_issue của luồng 1 lượt cũ (mode=llm) -> dict đúng schema Issue (source='llm')."""
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
        "rule_id": None,
    }


# ---------------------------------------------------------------------------
# Từng tầng LLM. Mỗi hàm trả (kết quả, thông báo lỗi | None) và không raise.
# ---------------------------------------------------------------------------
def _run_filter(code: str, cands: list[dict], stats: dict) -> tuple[list[dict], str | None]:
    """Tầng 2. Khi LLM lỗi: trả ứng viên thô theo fallback_candidates (Bandit đầy đủ, còn lại >= medium)."""
    if not cands:
        return [], None  # không có gì để lọc -> tiết kiệm một lời gọi
    sent, overflow = split_for_filter(cands, FILTER_MAX_CANDIDATES)
    stats["truncated"] = len(overflow)
    overflow_issues = [candidate_to_issue(c) for c in fallback_candidates(overflow)]
    try:
        result = llm_filter(code, sent)
        kept, suppressed = apply_filter_verdicts(sent, result["verdicts"])
        stats["suppressed"] = suppressed
        stats["rejected"] += result.get("rejected_suggestions", 0)
        return kept + overflow_issues, None
    except LLMError as e:
        log.warning("Tầng 2 thất bại: %s", e)
        err = f"Tầng 2: {e}"
    except Exception as e:  # noqa
        log.warning("Lỗi không mong đợi ở Tầng 2: %s", e)
        err = f"Tầng 2: {type(e).__name__}: {e}"
    return [candidate_to_issue(c) for c in fallback_candidates(cands)], err


def _run_gap(code: str, cands: list[dict], stats: dict) -> tuple[list[dict], str | None]:
    """Tầng 3. Lỗi trùng ứng viên của công cụ (cùng CWE, chồng dòng) bị bỏ và tính vào merged_count."""
    try:
        result = llm_find_gaps(code)
        stats["dropped"] += result.get("dropped", 0)
        stats["rejected"] += result.get("rejected_suggestions", 0)
        issues, overlap = drop_overlapping_gaps([gap_to_issue(g) for g in result["issues"]], cands)
        stats["merged"] += overlap
        return issues, None
    except LLMError as e:
        log.warning("Tầng 3 thất bại: %s", e)
        return [], f"Tầng 3: {e}"
    except Exception as e:  # noqa
        log.warning("Lỗi không mong đợi ở Tầng 3: %s", e)
        return [], f"Tầng 3: {type(e).__name__}: {e}"


def _run_single_pass(code: str, stats: dict) -> tuple[list[dict], str | None]:
    """mode=llm: 1 lượt tự do, không công cụ, không giới hạn loại lỗi (mốc so sánh)."""
    try:
        result = llm_review(code, [], prompts.SYSTEM_PROMPT, prompts.build_review_prompt)
        stats["rejected"] += result.get("rejected_suggestions", 0)
        stats["dropped"] += result.get("dropped_new_issues", 0)
        return [new_issue_to_issue(n) for n in result["new_issues"]], None
    except LLMError as e:
        log.warning("LLM thất bại (mode=llm): %s", e)
        return [], str(e)
    except Exception as e:  # noqa
        log.warning("Lỗi không mong đợi khi gọi LLM (mode=llm): %s", e)
        return [], f"{type(e).__name__}: {e}"


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def review_code(code: str, mode: str = "hybrid") -> dict:
    """Review code theo `mode` (xem docstring module).

    Nếu LLM lỗi hoặc chưa cấu hình ở mode filter/hybrid, vẫn trả kết quả công cụ thô (source = tên công cụ)
    kèm meta.llm_error; không bao giờ trả "code sạch" chỉ vì LLM hỏng.
    """
    mode = normalize_mode(mode)
    stats = {"suppressed": 0, "rejected": 0, "dropped": 0, "merged": 0, "truncated": 0}
    errors: list[str] = []
    counts = {"bandit": 0, "ruff": 0, "static": 0}
    warnings: list[str] = []
    cands: list[dict] = []
    issues: list[dict] = []
    llm_count = 0

    # --- Tầng 1
    if mode != "llm":
        t1 = collect_candidates(code, bandit=True, ruff=mode != "bandit", static=mode != "bandit")
        cands, counts, warnings = t1["candidates"], t1["counts"], t1["warnings"]
        stats["merged"] += t1["merged"]

    if mode in ("bandit", "tools"):
        issues = [candidate_to_issue(c) for c in cands]

    elif mode == "llm":
        if llm_is_configured():
            issues, err = _run_single_pass(code, stats)
            llm_count = len(issues)
            if err:
                errors.append(err)
        else:
            errors.append(LLM_NOT_CONFIGURED)

    else:  # filter | hybrid
        if llm_is_configured():
            issues, err = _run_filter(code, cands, stats)  # Tầng 2
            if err:
                errors.append(err)
            if mode == "hybrid" and USE_GAP_LAYER:
                if err:
                    errors.append("Tầng 3: bỏ qua vì Tầng 2 lỗi (cùng nhà cung cấp LLM)")
                else:
                    gaps, gerr = _run_gap(code, cands, stats)  # Tầng 3
                    issues += gaps
                    llm_count = len(gaps)
                    if gerr:
                        errors.append(gerr)
        else:
            errors.append(LLM_NOT_CONFIGURED)
            issues = [candidate_to_issue(c) for c in fallback_candidates(cands)]

    valid, invalid = validate_lines(issues, code)
    valid.sort(key=lambda x: (x.get("line", 0), -SEV_RANK.get(x.get("severity"), 0)))  # cùng dòng: nặng trước
    return {
        "issues": valid,
        "meta": {
            "mode": mode,
            "bandit_count": counts["bandit"],
            "ruff_count": counts["ruff"],
            "static_count": counts["static"],
            "candidate_count": len(cands),
            "truncated_candidates": stats["truncated"],
            "llm_count": llm_count,
            "dropped_invalid_lines": invalid + stats["dropped"],
            "merged_count": stats["merged"],
            "llm_error": "; ".join(errors) if errors else None,
            "tool_warnings": warnings,
            "suppressed_count": stats["suppressed"],
            "rejected_suggestions": stats["rejected"],
        },
    }
