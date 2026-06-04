from __future__ import annotations

import os
import sys

from . import LLMClient
from .default_label_util import build_label_result, read_input_records, write_result
from .knowledge_manager import load_knowledge


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

    # 读取 set_env.sh export 出来的环境变量。
    # 这 4 个变量名保持旧算法包习惯，方便改造时减少业务代码变化。
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

    print("[main.py] initializing LLMClient")
    # 算法包内部统一使用 LLMClient。
    # 当前环境使用 naie 还是 fly，由 Default_Label/__init__.py 自动判断。
    llm_client = LLMClient()
    runtime_info = llm_client.get_runtime_info()
    print(f"[main.py] runtime SDK: {runtime_info}")

    print("[main.py] calling LLMClient for each record")
    # 每条输入记录都通过同一个 LLMClient 调用大模型。
    # 业务流程只关心 call_llm 方法，无需直接 import naie/fly SDK。
    llm_results = [
        llm_client.call_llm(str(record["text"]))
        for record in records
    ]

    print("[main.py] building label result")
    label_result = build_label_result(records, knowledge_config, llm_results)

    result = {
        "success": True,
        "agent_id": agent_id,
        "input_path": input_path,
        "output_path": output_path,
        "knowledge": {
            "name": knowledge_config.get("name"),
            "version": knowledge_config.get("version"),
        },
        "runtime": runtime_info,
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
