from __future__ import annotations

from typing import Any


class NaieHttpClient:
    """在线飞轮 naie HTTP Client SDK 的 mock。"""

    def post_json(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        prompt = str(payload.get("prompt", ""))
        return {
            "provider": "naie",
            "path": path,
            "model": payload.get("model"),
            "output": f"naie mock LLM output for: {prompt}",
        }
