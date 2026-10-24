"""Chạy Bandit SAST lên snippet Python và chuẩn hóa kết quả theo hợp đồng v2.

Lý do dùng CLI thay vì Python API:
- dễ debug trực tiếp bằng `bandit -f json`
- tách biệt phiên bản với code
- chạy trong môi trường tạm, không ảnh hưởng repo
"""

import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import List

from .config import BANDIT_TIMEOUT

# Ánh xạ test_id của Bandit -> (cwe_id, type)
BANDIT_CWE_MAP = {
    "B608": ("CWE-89", "security"),   # hardcoded_sql_expressions
    "B602": ("CWE-78", "security"),   # subprocess_popen_with_shell_equals_true
    "B607": ("CWE-78", "security"),   # start_process_with_a_shell
    "B301": ("CWE-502", "security"),  # pickle
    "B403": ("CWE-502", "security"),  # import_pickle
    "B324": ("CWE-327", "security"),  # hashlib md5/sha1
    "B505": ("CWE-327", "security"),  # weak key
    "B105": ("CWE-798", "security"),  # hardcoded_password_string
    "B106": ("CWE-798", "security"),  # hardcoded_password_funcarg
    "B307": ("CWE-95", "security"),   # eval
    "B701": ("CWE-79", "security"),   # jinja2 autoescape
    "B501": ("CWE-295", "security"),  # requests verify=False
    "B108": ("CWE-377", "security"),  # hardcoded tmp
    "B404": ("CWE-78", "security"),   # import subprocess
    "B110": ("CWE-703", "quality"),   # try/except/pass
    "B101": ("CWE-703", "quality"),   # assert_used
}

# Gợi ý sửa nhanh hiển thị ngay trên Web UI (dù LLM chưa chạy)
BANDIT_FIXES = {
    "B608": "query = \"SELECT * FROM users WHERE id = ?\"\ncur.execute(query, (user_id,))",
    "B602": "subprocess.run(cmd.split(), shell=False, check=True)",
    "B607": "subprocess.run(['ls', '-l'], shell=False, check=True)",
    "B404": "subprocess.run([...], shell=False)",
    "B105": "PASSWORD = os.environ['APP_PASSWORD']",
    "B106": "password = os.environ.get('APP_PASSWORD')",
    "B324": "hashlib.sha256(data).hexdigest()  # dùng bcrypt/argon2 nếu là mật khẩu",
    "B505": "secrets.token_hex(32)",
    "B301": "data = json.loads(payload)",
    "B403": "import json",
    "B307": "ast.literal_eval(expr)",
    "B501": "requests.get(url, verify=True)",
    "B701": "from markupsafe import Markup\n... # escape đúng cách",
    "B108": "import tempfile\npath = os.path.join(tempfile.gettempdir(), name)",
    "B110": "except Exception as exc:\n    logger.exception(exc)",
    "B101": "if not value:\n    raise ValueError('value không hợp lệ')",
}


def _bandit_cmd() -> List[str]:
    exe = shutil.which("bandit")
    if exe:
        return [exe]
    return [sys.executable, "-m", "bandit"]


def _norm_sev(v: str) -> str:
    return {"HIGH": "high", "MEDIUM": "medium", "LOW": "low"}.get(str(v).upper(), "medium")


def _explanation(r: dict) -> str:
    parts = []
    name = r.get("test_name")
    if name:
        parts.append(f"Bandit: {name}")
    more = r.get("more_info")
    if more:
        parts.append(f"Tham khảo: {more}")
    snip = (r.get("code") or "").strip()
    if snip:
        parts.append(f"Đoạn mã: {snip}")
    return " | ".join(parts)


def run_bandit(code: str) -> List[dict]:
    if not code.strip():
        return []

    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "snippet.py"
        f.write_text(code, encoding="utf-8")
        cmd = _bandit_cmd() + ["-f", "json", "-q", "--confidence-level", "all", str(f)]
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True,
                timeout=BANDIT_TIMEOUT, encoding="utf-8", errors="replace"
            )
        except (subprocess.TimeoutExpired, OSError):
            return []

    # Bandit trả exit 1 khi có finding
    if proc.returncode not in (0, 1):
        return []

    raw = proc.stdout.strip()
    if not raw:
        return []

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", raw, re.S)
        if not m:
            return []
        try:
            data = json.loads(m.group(0))
        except json.JSONDecodeError:
            return []

    out: List[dict] = []
    for res in data.get("results", []):
        tid = res.get("test_id", "")
        cwe, typ = BANDIT_CWE_MAP.get(tid, (None, "quality"))
        out.append({
            "line": int(res.get("line_number") or 1),
            "type": typ,
            "severity": _norm_sev(res.get("issue_severity", "MEDIUM")),
            "confidence": _norm_sev(res.get("issue_confidence", "MEDIUM")),
            "cwe_id": cwe,
            "message": (res.get("issue_text") or res.get("test_name") or "Bandit finding").strip(),
            "explanation": _explanation(res),
            "suggestion": BANDIT_FIXES.get(tid, ""),
            "source": "bandit",
            "_test_id": tid,
        })
    return out
