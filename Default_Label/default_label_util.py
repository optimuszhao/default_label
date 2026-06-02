from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def read_input_records(input_path: str) -> list[dict[str, Any]]:
    input_dir = Path(input_path).expanduser().resolve()
    input_file = input_dir / "input.json"

    if not input_file.exists():
        raise FileNotFoundError(f"input file not found: {input_file}")

    try:
        data = json.loads(input_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON in input file: {input_file}: {exc}") from exc

    if not isinstance(data, list):
        raise ValueError(f"input file must contain a JSON list: {input_file}")

    records: list[dict[str, Any]] = []
    for index, item in enumerate(data, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"record #{index} must be a JSON object")
        if "id" not in item or "text" not in item:
            raise ValueError(f"record #{index} must contain id and text")
        records.append(item)

    return records


def build_label_result(
    records: list[dict[str, Any]],
    knowledge_config: dict[str, Any],
) -> list[dict[str, Any]]:
    label = str(knowledge_config.get("default_label", "default_label"))
    score = float(knowledge_config.get("score", 0.98))

    return [
        {
            "id": str(record["id"]),
            "text": str(record["text"]),
            "label": label,
            "score": score,
        }
        for record in records
    ]


def write_result(output_path: str, result: dict[str, Any]) -> Path:
    output_dir = Path(output_path).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    result_file = output_dir / "result.json"
    result_file.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return result_file
