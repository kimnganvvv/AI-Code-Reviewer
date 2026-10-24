import os

import torch
from flask import Flask, jsonify, request
from flask_login import login_required

app = Flask(__name__)
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "uploads")


@app.route("/api/models/load", methods=["POST"])
@login_required
def load_checkpoint():
    upload = request.files["checkpoint"]
    path = os.path.join(UPLOAD_DIR, "latest.pt")
    upload.save(path)
    state = torch.load(path, map_location="cpu")
    return jsonify({"layers": list(state.keys())})
