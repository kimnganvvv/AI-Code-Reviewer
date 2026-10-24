import requests

HF_TOKEN = "hf_k3Jd9xQp2LmN8vTz5RwYb7CsUeAa1GhO"
MODEL_URL = "https://huggingface.co/api/models/sushi-demand/forecaster"


def fetch_model_info():
    headers = {"Authorization": f"Bearer {HF_TOKEN}"}
    response = requests.get(MODEL_URL, headers=headers, timeout=10)
    response.raise_for_status()
    return response.json()
