"""Mock API trả dữ liệu giả đúng theo hợp đồng v2.

Dùng để Người 2 (Chrome Extension) và Người 3 (prompt) phát triển song song
mà không cần API key LLM.
"""

from typing import List

# Mẫu code dùng chung cho Web UI, sample endpoint và demo
SAMPLE_CODE = """import os
import sqlite3
import subprocess

PASSWORD = "admin123"


def get_user(conn, user_id):
    query = "SELECT * FROM users WHERE id = " + user_id
    return conn.execute(query).fetchone()


def run_cmd(cmd):
    return subprocess.call(cmd, shell=True)


def total(values):
    return sum(values) / len(values)
"""


def mock_issues() -> List[dict]:
    return [
        {
            "line": 6,
            "type": "security",
            "severity": "high",
            "confidence": "high",
            "cwe_id": "CWE-798",
            "message": "Hardcoded password string",
            "explanation": "Chuỗi 'admin123' được gán trực tiếp trong mã nguồn. Bất kỳ ai đọc được source đều có thể lấy mật khẩu.",
            "suggestion": "PASSWORD = os.environ['APP_PASSWORD']",
            "source": "bandit",
        },
        {
            "line": 11,
            "type": "security",
            "severity": "high",
            "confidence": "high",
            "cwe_id": "CWE-89",
            "message": "SQL injection qua nối chuỗi",
            "explanation": "user_id được nối trực tiếp vào câu SQL. Kẻ tấn công có thể điều khiển truy vấn.",
            "suggestion": "conn.execute('SELECT * FROM users WHERE id = ?', (user_id,))",
            "source": "both",
        },
        {
            "line": 15,
            "type": "security",
            "severity": "high",
            "confidence": "high",
            "cwe_id": "CWE-78",
            "message": "subprocess.call với shell=True",
            "explanation": "shell=True truyền chuỗi trực tiếp cho shell -> dễ bị Command Injection.",
            "suggestion": "subprocess.run(cmd.split(), shell=False)",
            "source": "bandit",
        },
        {
            "line": 19,
            "type": "bug",
            "severity": "medium",
            "confidence": "medium",
            "cwe_id": None,
            "message": "Có thể chia cho 0",
            "explanation": "Nếu values là danh sách rỗng, len(values)=0 -> ZeroDivisionError.",
            "suggestion": "return sum(values) / len(values) if values else 0",
            "source": "llm",
        },
        {
            "line": 3,
            "type": "quality",
            "severity": "low",
            "confidence": "medium",
            "cwe_id": None,
            "message": "Import không được sử dụng",
            "explanation": "sqlite3 được import nhưng không dùng trong đoạn mã.",
            "suggestion": "Xóa dòng import sqlite3",
            "source": "llm",
        },
    ]
