from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def load_knowledge(knowledge_path: str) -> dict[str, Any]:
    path = Path(knowledge_path).expanduser().resolve()

    if not path.exists():
        raise FileNotFoundError(f"knowledge file not found: {path}")

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON in knowledge file: {path}: {exc}") from exc

    if not isinstance(data, dict):
        raise ValueError(f"knowledge file must contain a JSON object: {path}")

    return data
