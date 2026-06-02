from __future__ import annotations

import os
import sys
from typing import Any

import naie_api
import naie_impl_network

from default_label_util import build_label_result, read_input_records, write_result
from knowledge_manager import load_knowledge


REQUIRED_ENV_KEYS = [
    "Data_Input_Path",
    "Data_Output_Path",
    "AgentID",
    "Knowledge",
]


def get_required_env() -> dict[str, str]:
    env = {key: os.getenv(key) for key in REQUIRED_ENV_KEYS}
    missing = [key for key, value in env.items() if not value]
    if missing:
        raise RuntimeError(f"missing required environment variables: {', '.join(missing)}")
    return {key: str(value) for key, value in env.items()}


def run() -> int:
    print("[main.py] Default Label mock run started")

    env = get_required_env()
    input_path = env["Data_Input_Path"]
    output_path = env["Data_Output_Path"]
    agent_id = env["AgentID"]
    knowledge_path = env["Knowledge"]

    print(f"[main.py] Data_Input_Path: {input_path}")
    print(f"[main.py] Data_Output_Path: {output_path}")
    print(f"[main.py] AgentID: {agent_id}")
    print(f"[main.py] Knowledge: {knowledge_path}")

    print("[main.py] loading input records")
    records = read_input_records(input_path)
    print(f"[main.py] loaded {len(records)} input records")

    print("[main.py] loading knowledge")
    knowledge_config = load_knowledge(knowledge_path)
    print(
        "[main.py] knowledge loaded: "
        f"{knowledge_config.get('name')} {knowledge_config.get('version')}"
    )

    print("[main.py] calling mock SDKs")
    api_version = naie_api.get_api_version()
    network_probe: dict[str, Any] = naie_impl_network.get_network_label_result(
        str(records[0]["text"]) if records else ""
    )
    network_version = naie_impl_network.get_network_impl_version()
    print(f"[main.py] naie_api version: {api_version}")
    print(f"[main.py] naie_impl_network version: {network_version}")
    print(f"[main.py] network SDK mock result: {network_probe}")

    print("[main.py] building label result")
    label_result = build_label_result(records, knowledge_config)

    result = {
        "success": True,
        "agent_id": agent_id,
        "input_path": input_path,
        "output_path": output_path,
        "knowledge": {
            "name": knowledge_config.get("name"),
            "version": knowledge_config.get("version"),
        },
        "sdk": {
            "naie_api_version": api_version,
            "naie_impl_network_version": network_version,
        },
        "label_result": label_result,
    }

    result_file = write_result(output_path, result)
    print(f"[main.py] result written: {result_file}")
    print("[main.py] Default Label mock run completed")
    return 0


def main() -> int:
    try:
        return run()
    except Exception as exc:
        print(f"[main.py] ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
