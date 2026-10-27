"""Lớp "ứng viên" (candidate) dùng chung cho Tầng 1 -> Tầng 2.

Mọi công cụ (Bandit, Ruff, static) cùng trả về dict ứng viên có các khóa:
    tool, rule_id, line, end_line, type, severity, confidence, cwe_id, message, explanation, suggestion
Module này lo: chuẩn hóa Bandit về dạng đó, khử trùng giữa các công cụ, chọn ứng viên gửi LLM,
đánh `candidate_id` (C1, C2...), áp phán quyết của LLM và đổi sang Issue của hợp đồng API.
"""

from typing import Dict, List, Optional, Tuple

from .bandit_runner import run_bandit
from .ruff_runner import run_ruff
from .static_detectors import run_static

SEV_RANK = {"low": 1, "medium": 2, "high": 3}
TOOL_PRIORITY = {"bandit": 0, "ruff": 1, "static": 2}  # số nhỏ = ưu tiên giữ khi trùng


# ---------------------------------------------------------------------------
# Chuẩn hóa
# ---------------------------------------------------------------------------
def from_bandit_issue(b: dict) -> dict:
    """Issue do bandit_runner.run_bandit trả về -> ứng viên."""
    line = int(b.get("line") or 1)
    explanation = b.get("explanation", "")
    hint = b.get("suggestion", "")
    if hint:
        explanation = f"{explanation} | Hướng khắc phục tham khảo (không phải bản vá áp dụng): {hint}"
    return {
        "tool": "bandit",
        "rule_id": b.get("_test_id") or "",
        "line": line,
        "end_line": line,
        "type": b.get("type", "quality"),
        "severity": b.get("severity", "medium"),
        "confidence": b.get("confidence", "medium"),
        "cwe_id": b.get("cwe_id"),
        "message": b.get("message", ""),
        "explanation": explanation,
        # Chỉ suggestion đã được tạo theo đúng đoạn line..end_line mới được đưa vào ô áp dụng.
        "suggestion": "",
    }


# ---------------------------------------------------------------------------
# Khử trùng giữa các công cụ
# ---------------------------------------------------------------------------
def _same_finding(a: dict, b: dict) -> bool:
    if a["tool"] == b["tool"]:
        return a["rule_id"] == b["rule_id"] and a["line"] == b["line"]
    # Khác công cụ: trùng khi cùng CWE (khác null) và lệch tối đa 1 dòng
    return bool(a.get("cwe_id")) and a.get("cwe_id") == b.get("cwe_id") and abs(a["line"] - b["line"]) <= 1


def dedupe_candidates(cands: List[dict]) -> Tuple[List[dict], int]:
    """Giữ ứng viên của công cụ ưu tiên cao hơn (bandit > ruff > static). Trả (danh sách, số bị gộp)."""
    kept: List[dict] = []
    merged = 0
    for c in sorted(cands, key=lambda x: (TOOL_PRIORITY.get(x["tool"], 9), x["line"])):
        dup = next((k for k in kept if _same_finding(k, c)), None)
        if dup is None:
            kept.append(c)
        else:
            merged += 1
    kept.sort(key=lambda x: (x["line"], TOOL_PRIORITY.get(x["tool"], 9)))
    return kept, merged


def collect_candidates(code: str, *, bandit: bool = True, ruff: bool = True, static: bool = True) -> dict:
    """Chạy Tầng 1. Trả về {candidates, counts, warnings, merged}."""
    raw: List[dict] = []
    counts = {"bandit": 0, "ruff": 0, "static": 0}
    warnings: List[str] = []

    if bandit:
        b = [from_bandit_issue(x) for x in run_bandit(code)]
        counts["bandit"] = len(b)
        raw += b
    if ruff:
        r, w = run_ruff(code)
        counts["ruff"] = len(r)
        raw += r
        if w:
            warnings.append(w)
    if static:
        s, w = run_static(code)
        counts["static"] = len(s)
        raw += s
        if w:
            warnings.append(w)

    cands, merged = dedupe_candidates(raw)
    return {"candidates": cands, "counts": counts, "warnings": warnings, "merged": merged}


# ---------------------------------------------------------------------------
# Chọn ứng viên gửi LLM / phương án dự phòng
# ---------------------------------------------------------------------------
def split_for_filter(cands: List[dict], limit: int) -> Tuple[List[dict], List[dict]]:
    """Giữ tối đa `limit` ứng viên quan trọng nhất (bảo mật trước, rồi severity cao) để gửi LLM.
    Trả (sẽ gửi - đã sắp theo dòng và gán candidate_id, phần vượt trần)."""
    ranked = sorted(
        cands,
        key=lambda c: (0 if c["tool"] == "bandit" else 1, -SEV_RANK.get(c["severity"], 0), c["line"]),
    )
    sent, overflow = ranked[:limit], ranked[limit:]
    sent.sort(key=lambda c: (c["line"], TOOL_PRIORITY.get(c["tool"], 9)))
    for i, c in enumerate(sent, start=1):
        c["candidate_id"] = f"C{i}"
    return sent, overflow


def fallback_candidates(cands: List[dict]) -> List[dict]:
    """Khi không có phán quyết LLM: giữ MỌI cảnh báo Bandit (bỏ sót bảo mật nguy hiểm hơn báo thừa),
    còn Ruff/static chỉ giữ mức >= medium để không đổ nhiễu lên người dùng."""
    return [c for c in cands if c["tool"] == "bandit" or SEV_RANK.get(c["severity"], 0) >= SEV_RANK["medium"]]


# ---------------------------------------------------------------------------
# Ứng viên -> Issue
# ---------------------------------------------------------------------------
def candidate_to_issue(c: dict) -> dict:
    return {
        "line": c["line"],
        "end_line": c.get("end_line") or c["line"],
        "type": c["type"],
        "severity": c["severity"],
        "confidence": c["confidence"],
        "cwe_id": c.get("cwe_id"),
        "message": c["message"],
        "explanation": c.get("explanation", ""),
        "suggestion": c.get("suggestion") or "",
        "source": c["tool"],
        "rule_id": c.get("rule_id") or None,
    }


def apply_filter_verdicts(sent: List[dict], verdicts: List[dict]) -> Tuple[List[dict], int]:
    """Áp phán quyết Tầng 2 lên ứng viên đã gửi. Trả (issue được giữ, số bị loại).

    - keep=false              -> loại, đếm vào suppressed.
    - không có verdict / auto_default -> giữ nguyên source=<tool> (bỏ sót nguy hiểm hơn báo thừa).
    - keep=true               -> source='both', dùng explanation/confidence của LLM. Bản vá của LLM thay thế
                                 hoàn toàn gợi ý mẫu của công cụ (LLM có thể chủ ý để null vì không vá an toàn
                                 được), và chỉ nhận khi khoảng dòng của nó bao trùm dòng ứng viên.
    """
    by_id: Dict[str, dict] = {v.get("candidate_id"): v for v in verdicts or []}
    kept: List[dict] = []
    suppressed = 0
    for c in sent:
        issue = candidate_to_issue(c)
        v: Optional[dict] = by_id.get(c.get("candidate_id"))
        if v is None or v.get("auto_default"):
            kept.append(issue)
            continue
        if not v.get("keep", True):
            # These AST rules supply bounded deterministic patches for the
            # recognized defect. Do not let the LLM filter hide the patch.
            protected_patch = (
                c.get("rule_id") == "OBO002"
                or c.get("rule_id") == "DIV001"
            )
            if c.get("tool") == "static" and protected_patch and c.get("suggestion"):
                kept.append(issue)
                continue
            suppressed += 1
            continue

        issue["source"] = "both"
        if v.get("explanation"):
            issue["explanation"] = v["explanation"]
        if v.get("confidence"):
            issue["confidence"] = v["confidence"]
        # Keep a deterministic tool fix (e.g. an AST-derived one-line correction).
        # LLM suggestions are used only when the tool has no local fix to preserve.
        sug, v_line, v_end = v.get("suggestion"), v.get("line"), v.get("end_line")
        if not issue.get("suggestion") and sug and v_line is not None and v_end is not None and v_line <= c["line"] <= v_end:
            issue["suggestion"] = sug
            issue["line"], issue["end_line"] = v_line, v_end
        kept.append(issue)
    return kept, suppressed


# ---------------------------------------------------------------------------
# Tầng 3: loại lỗi LLM tìm thêm mà trùng với ứng viên của công cụ
# ---------------------------------------------------------------------------
def drop_overlapping_gaps(gap_issues: List[dict], cands: List[dict]) -> Tuple[List[dict], int]:
    """Bỏ lỗi Tầng 3 nếu chồng dòng với một ứng viên cùng CWE (kể cả ứng viên Tầng 2 đã loại:
    quyết định của bộ lọc không bị Tầng 3 lật lại)."""
    kept, dropped = [], 0
    for g in gap_issues:
        overlap = any(
            g.get("cwe_id") and g["cwe_id"] == c.get("cwe_id")
            and g["line"] <= (c.get("end_line") or c["line"]) + 1 and c["line"] <= g["end_line"] + 1
            for c in cands
        )
        if overlap:
            dropped += 1
        else:
            kept.append(g)
    return kept, dropped
