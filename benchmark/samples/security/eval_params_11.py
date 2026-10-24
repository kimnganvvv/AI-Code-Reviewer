from flask import Flask, jsonify, request

from .trainer import run_training

app = Flask(__name__)


@app.route("/api/train", methods=["POST"])
def start_training():
    payload = request.get_json()
    params = eval(payload["params"])
    job_id = run_training(payload["dataset"], **params)
    return jsonify({"job_id": job_id})
