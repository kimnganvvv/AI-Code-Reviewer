import ast

import torch
import yaml

ALLOWED_PARAMS = {"lr", "epochs", "batch_size"}


def load_checkpoint(path):
    return torch.load(path, map_location="cpu", weights_only=True)


def load_config(path):
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def parse_params(text):
    params = ast.literal_eval(text)
    if not isinstance(params, dict) or not set(params) <= ALLOWED_PARAMS:
        raise ValueError("Siêu tham số không hợp lệ")
    return params
