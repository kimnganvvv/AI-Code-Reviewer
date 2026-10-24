import subprocess

from flask import Flask, jsonify, request

app = Flask(__name__)


@app.route("/api/admin/ping")
def ping_printer():
    """Kiểm tra máy in bếp còn kết nối mạng hay không."""
    host = request.args.get("host", "")
    result = subprocess.run(
        f"ping -c 1 -W 2 {host}",
        shell=True,
        capture_output=True,
        text=True,
    )
    return jsonify({"host": host, "reachable": result.returncode == 0})
