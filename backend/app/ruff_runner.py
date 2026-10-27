"""Tầng 1b: chạy Ruff lấy ứng viên bug/quality, chuẩn hóa thành "ứng viên" (candidate).

Chỉ chọn nhóm rule không trùng Bandit: F (pyflakes), B (bugbear), SIM (chọn lọc),
C901 (độ phức tạp) và vài rule PLR về kích thước hàm. Nhóm "S" của Ruff bị bỏ có chủ đích
vì là bản port của Bandit.

Cấu hình được ghi vào file ruff.toml tạm và truyền bằng `--config`, nên không bị ảnh hưởng
bởi pyproject.toml / ruff.toml của repo đang chạy backend.
"""

import json
import logging
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import List, Optional, Tuple

from .config import (
    RUFF_IGNORE, RUFF_MAX_ARGS, RUFF_MAX_BRANCHES, RUFF_MAX_COMPLEXITY, RUFF_MAX_RETURNS,
    RUFF_MAX_STATEMENTS, RUFF_SELECT, RUFF_TIMEOUT, USE_RUFF,
)

log = logging.getLogger("ai-code-reviewer")

# (tiền tố rule, type, severity, confidence, cwe). Khớp tiền tố DÀI NHẤT thắng.
_RULES = [
    ("F401", "quality", "low", "high", None),      # import không dùng
    ("F841", "quality", "low", "high", None),      # biến cục bộ không dùng
    ("F811", "quality", "medium", "high", None),   # định nghĩa lại chưa dùng
    ("F821", "bug", "medium", "medium", None),     # tên chưa định nghĩa (snippet có thể là đoạn trích)
    ("F822", "bug", "medium", "medium", None),
    ("F823", "bug", "medium", "medium", None),
    ("F632", "bug", "medium", "high", None),       # `is` với literal
    ("F50", "bug", "medium", "high", None),        # lỗi chuỗi định dạng %
    ("F52", "bug", "medium", "high", None),        # lỗi str.format
    ("F54", "bug", "medium", "high", None),
    ("F6", "bug", "medium", "medium", None),
    ("F7", "bug", "medium", "medium", None),
    ("F", "quality", "low", "medium", None),
    ("B006", "bug", "medium", "high", None),       # mutable default argument
    ("B012", "bug", "medium", "high", None),       # return trong finally
    ("B023", "bug", "medium", "medium", None),     # closure không bind biến vòng lặp
    ("B", "quality", "low", "medium", None),
    ("SIM115", "bug", "medium", "medium", "CWE-404"),  # open() không dùng context manager
    ("SIM", "quality", "low", "low", None),
    ("C901", "quality", "medium", "medium", None),
    ("PLR", "quality", "low", "medium", None),
]
_DEFAULT_RULE = ("quality", "low", "medium", None)
_RULE_CODE_RE = re.compile(r"^[A-Z]{1,4}\d{2,4}$")  # F401, B006, SIM115, PLR0913...


def _classify(code: str) -> Tuple[str, str, str, Optional[str]]:
    best = None
    for prefix, *rest in _RULES:
        if code.startswith(prefix) and (best is None or len(prefix) > len(best[0])):
            best = (prefix, *rest)
    return tuple(best[1:]) if best else _DEFAULT_RULE  # type: ignore[return-value]


def _ruff_cmd() -> Optional[List[str]]:
    exe = shutil.which("ruff")
    if exe:
        return [exe]
    # `pip install ruff` cũng cho chạy được bằng `python -m ruff`
    probe = subprocess.run([sys.executable, "-m", "ruff", "--version"], capture_output=True, text=True)
    return [sys.executable, "-m", "ruff"] if probe.returncode == 0 else None


def ruff_available() -> bool:
    return USE_RUFF and _ruff_cmd() is not None


def _toml_list(items: List[str]) -> str:
    return "[" + ", ".join(json.dumps(x) for x in items) + "]"


def _config_text() -> str:
    return (
        "[lint]\n"
        f"select = {_toml_list(RUFF_SELECT)}\n"
        f"ignore = {_toml_list(RUFF_IGNORE)}\n"
        "[lint.mccabe]\n"
        f"max-complexity = {RUFF_MAX_COMPLEXITY}\n"
        "[lint.pylint]\n"
        f"max-args = {RUFF_MAX_ARGS}\n"
        f"max-branches = {RUFF_MAX_BRANCHES}\n"
        f"max-returns = {RUFF_MAX_RETURNS}\n"
        f"max-statements = {RUFF_MAX_STATEMENTS}\n"
    )


def run_ruff(code: str) -> Tuple[List[dict], Optional[str]]:
    """Trả về (danh sách ứng viên, cảnh báo | None). Không bao giờ raise."""
    if not USE_RUFF or not code.strip():
        return [], None
    cmd = _ruff_cmd()
    if cmd is None:
        return [], "Ruff chưa được cài (pip install ruff); bỏ qua ứng viên bug/quality từ Ruff."

    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "snippet.py"
        cfg = Path(tmp) / "ruff.toml"
        src.write_text(code, encoding="utf-8")
        cfg.write_text(_config_text(), encoding="utf-8")
        full = cmd + ["check", "--config", str(cfg), "--no-cache", "--output-format", "json", str(src)]
        try:
            proc = subprocess.run(
                full, capture_output=True, text=True, timeout=RUFF_TIMEOUT, encoding="utf-8", errors="replace",
            )
        except (subprocess.TimeoutExpired, OSError) as e:
            return [], f"Ruff lỗi khi chạy: {type(e).__name__}"

    # Ruff: 0 = sạch, 1 = có vi phạm, 2 = lỗi cấu hình/nội bộ
    if proc.returncode not in (0, 1):
        log.warning("Ruff exit %s: %s", proc.returncode, (proc.stderr or "")[:300])
        return [], "Ruff trả lỗi (kiểm tra RUFF_SELECT/RUFF_IGNORE); bỏ qua ứng viên từ Ruff."
    try:
        data = json.loads(proc.stdout or "[]")
    except json.JSONDecodeError:
        return [], "Không đọc được kết quả JSON của Ruff."

    out: List[dict] = []
    warning = None
    for d in data:
        code_id = d.get("code")
        # Lỗi cú pháp: bản cũ để code=null, bản mới (>=0.1x) dùng code="invalid-syntax". Đều không phải rule.
        if not code_id or not _RULE_CODE_RE.match(code_id):
            warning = "Mã nguồn có lỗi cú pháp nên Ruff không phân tích được đầy đủ."
            continue
        typ, sev, conf, cwe = _classify(code_id)
        msg = (d.get("message") or code_id).strip()
        row = int((d.get("location") or {}).get("row") or 1)
        end_row = int((d.get("end_location") or {}).get("row") or row)
        explanation = f"Ruff {code_id}: {msg}"
        if d.get("url"):
            explanation += f" | Tham khảo: {d['url']}"
        out.append({
            "tool": "ruff",
            "rule_id": code_id,
            "line": row,
            "end_line": max(end_row, row),
            "type": typ,
            "severity": sev,
            "confidence": conf,
            "cwe_id": cwe,
            "message": msg,
            "explanation": explanation,
            "suggestion": "",
        })
    return out, warning
