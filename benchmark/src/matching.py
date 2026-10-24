"""Quy tắc khớp lỗi dự đoán với nhãn chuẩn của một file.

Một dự đoán khớp một nhãn khi:
  1. cùng `type` (security | bug | quality);
  2. số dòng nằm trong dung sai, theo một trong các cách:
       - trong khoảng [line - tol, end_line + tol] (end_line chỉ có ở lỗi cấp hàm,
         mặc định end_line = line);
       - quanh một dòng trong `also_lines` (± tol).
CWE KHÔNG bắt buộc (Bandit và LLM có thể gán mã CWE khác nhau cho cùng một lỗi).
Mỗi nhãn chỉ khớp tối đa một dự đoán và ngược lại.
"""
from __future__ import annotations

from dataclasses import dataclass, field

DEFAULT_TOL = 2


@dataclass
class MatchResult:
    tp: int = 0
    fp: int = 0
    fn: int = 0
    matched: list = field(default_factory=list)          # [(dự đoán, nhãn)]
    false_positives: list = field(default_factory=list)  # dự đoán không khớp
    missed: list = field(default_factory=list)           # nhãn không được tìm thấy


def _is_int(x) -> bool:
    return isinstance(x, int) and not isinstance(x, bool)


def _distance(pred: dict, gold: dict, tol: int):
    """Trả về khoảng cách dòng nếu dự đoán khớp nhãn, ngược lại None."""
    line = pred.get("line")
    if not _is_int(line) or pred.get("type") != gold["type"]:
        return None
    start = gold["line"]
    end = gold.get("end_line", start)
    if start - tol <= line <= end + tol:
        return 0 if start <= line <= end else min(abs(line - start), abs(line - end))
    for extra in gold.get("also_lines", ()):
        if abs(line - extra) <= tol:
            return abs(line - extra)
    return None


def match_file(predictions, gold_issues, tol: int = DEFAULT_TOL) -> MatchResult:
    predictions = [p for p in (predictions or []) if isinstance(p, dict)]
    used: set[int] = set()
    result = MatchResult()
    for gold in gold_issues:
        best = None  # (khoảng cách, chỉ số dự đoán)
        for idx, pred in enumerate(predictions):
            if idx in used:
                continue
            d = _distance(pred, gold, tol)
            if d is not None and (best is None or d < best[0]):
                best = (d, idx)
        if best is None:
            result.missed.append(gold)
        else:
            used.add(best[1])
            result.matched.append((predictions[best[1]], gold))
    result.false_positives = [p for i, p in enumerate(predictions) if i not in used]
    result.tp = len(result.matched)
    result.fp = len(result.false_positives)
    result.fn = len(result.missed)
    return result
