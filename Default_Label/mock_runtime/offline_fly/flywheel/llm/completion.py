from __future__ import annotations

from typing import Any


def chat(llm_dict: dict[str, Any], prompt: str) -> dict[str, Any]:
    """离线飞轮 flywheel.llm.completion.chat 的 mock。"""

    return {
        "provider": "fly",
        "model": llm_dict.get("model"),
        "base_url": llm_dict.get("base_url"),
        "output": f"fly mock LLM output for: {prompt}",
    }
