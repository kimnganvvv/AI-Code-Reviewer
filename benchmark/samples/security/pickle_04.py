import base64
import pickle

from flask import Flask, jsonify, request

app = Flask(__name__)


def load_cart_from_cookie():
    raw = request.cookies.get("cart")
    if not raw:
        return {}
    return pickle.loads(base64.b64decode(raw))


@app.route("/api/cart")
def view_cart():
    cart = load_cart_from_cookie()
    total = sum(item["price"] * item["quantity"] for item in cart.values())
    return jsonify({"items": list(cart.values()), "total": total})
