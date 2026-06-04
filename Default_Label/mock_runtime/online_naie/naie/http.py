from __future__ import annotations

from typing import Any


class HttpClient:
    """在线飞轮 naie.http.HttpClient 的 mock。"""

    def post_json(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        messages = payload.get("messages", [])
        prompt = ""
        if messages:
            prompt = str(messages[-1].get("content", ""))

        return {
            "provider": "naie",
            "path": path,
            "model": payload.get("model"),
            "output": f"naie mock LLM output for: {prompt}",
        }
