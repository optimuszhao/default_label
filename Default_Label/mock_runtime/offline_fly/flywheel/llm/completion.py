from __future__ import annotations

from typing import Any


def chat(model: str, messages: list[dict[str, Any]]) -> dict[str, Any]:
    """离线飞轮 flywheel.llm.completion.chat 的 mock。"""

    prompt = ""
    if messages:
        prompt = str(messages[-1].get("content", ""))

    return {
        "provider": "fly",
        "model": model,
        "output": f"fly mock LLM output for: {prompt}",
    }
