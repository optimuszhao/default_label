from __future__ import annotations

from typing import Any


class FlyHttpClient:
    """离线飞轮 fly HTTP Client SDK 的 mock。"""

    def post_json(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        prompt = str(payload.get("prompt", ""))
        return {
            "provider": "fly",
            "path": path,
            "model": payload.get("model"),
            "output": f"fly mock LLM output for: {prompt}",
        }
