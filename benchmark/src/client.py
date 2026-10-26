"""Client gọi API review. runner chỉ biết giao diện review(code, mode)."""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Protocol

import requests


@dataclass
class ReviewResult:
    issues: list = field(default_factory=list)
    meta: dict = field(default_factory=dict)
    latency: float = 0.0
    error: str | None = None


class ReviewClient(Protocol):
    def review(self, code: str, mode: str) -> ReviewResult: ...


class HttpReviewClient:
    def __init__(self, base_url: str = "http://localhost:8000", timeout: float = 180):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def health(self) -> dict:
        r = requests.get(f"{self.base_url}/health", timeout=10)
        r.raise_for_status()
        return r.json()

    def review(self, code: str, mode: str) -> ReviewResult:
        start = time.perf_counter()
        try:
            r = requests.post(
                f"{self.base_url}/review",
                params={"mode": mode},
                json={"code": code},
                timeout=self.timeout,
            )
            latency = time.perf_counter() - start
            if r.status_code != 200:
                return ReviewResult(latency=latency, error=f"HTTP {r.status_code}: {r.text[:200]}")
            data = r.json()
        except (requests.RequestException, ValueError) as ex:
            return ReviewResult(latency=time.perf_counter() - start, error=str(ex))

        if isinstance(data, list):  # phòng khi backend trả mảng trơn
            return ReviewResult(issues=data, latency=latency)
        return ReviewResult(
            issues=data.get("issues") or [],
            meta=data.get("meta") or {},
            latency=latency,
        )
