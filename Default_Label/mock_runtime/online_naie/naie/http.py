from __future__ import annotations

from typing import Any


class HttpClient:
    """在线飞轮 naie.http.HttpClient 的 mock。"""

    def post(self, url: str, body: dict[str, Any]) -> dict[str, Any]:
        messages = body.get("messages", [])
        prompt = ""
        if messages:
            prompt = str(messages[-1].get("content", ""))

        return {
            "provider": "naie",
            "url": url,
            "model": body.get("model"),
            "output": f"naie mock LLM output for: {prompt}",
        }
