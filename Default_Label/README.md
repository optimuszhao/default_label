# Default Label Mock Project

这是一个本地可运行的 Python mock 项目，用来验证 Default Label 算法包在在线飞轮和离线飞轮两种环境里的 SDK 适配方案。

核心设计：

- `bin/set_env.sh` 负责解析参数、export 环境变量、启动 `main.py`。
- `Default_Label/__init__.py` 负责自动识别 SDK 环境，并统一封装 `LLMClient`。
- 业务代码统一调用 `LLMClient.call_llm()`，业务流程保持稳定。
- 本地 mock runtime 用来模拟在线飞轮的 `naie` 依赖和离线飞轮的 `fly` 依赖。

## 目录结构

```text
Default_Label/
├── __init__.py
├── bin/
│   └── set_env.sh
├── knowledge/
│   └── default_knowledge.json
├── template/
│   └── default_template.txt
├── mock_data/
│   ├── input/
│   │   └── input.json
│   └── output/
├── mock_runtime/
│   ├── online_naie/
│   │   ├── naie_http_client.py
│   │   └── naie_logging.py
│   └── offline_fly/
│       ├── fly_http_client.py
│       └── fly_logging.py
├── default_label_util.py
├── knowledge_manager.py
├── main.py
├── plugin.yaml
└── README.md
```

## 环境要求

推荐使用 Python 3.9+。macOS / Linux 默认 bash 环境即可运行。

## 运行在线飞轮 mock

进入项目目录：

```bash
cd Default_Label
```

给入口脚本加执行权限：

```bash
chmod +x bin/set_env.sh
```

执行算法包，模拟在线飞轮 naie 环境：

```bash
DEFAULT_LABEL_MOCK_RUNTIME=online_naie ./bin/set_env.sh \
  --data-input-path "./mock_data/input" \
  --data-output-path "./mock_data/output" \
  --agent-id "agent-001" \
  --knowledge "./knowledge/default_knowledge.json"
```

查看输出：

```bash
cat mock_data/output/result.json
```

输出里会看到：

```json
"runtime": {
  "sdk_name": "naie",
  "logging_sdk": "naie_logging",
  "http_client_sdk": "naie_http_client"
}
```

## 运行离线飞轮 mock

执行算法包，模拟离线飞轮 fly 环境：

```bash
DEFAULT_LABEL_MOCK_RUNTIME=offline_fly ./bin/set_env.sh \
  --data-input-path "./mock_data/input" \
  --data-output-path "./mock_data/output" \
  --agent-id "agent-001" \
  --knowledge "./knowledge/default_knowledge.json"
```

输出里会看到：

```json
"runtime": {
  "sdk_name": "fly",
  "logging_sdk": "fly_logging",
  "http_client_sdk": "fly_http_client"
}
```

## 真实飞轮环境运行方式

真实在线/离线飞轮环境通常已经提供 logging 和 httpclient SDK。运行时可以关闭本地 mock runtime：

```bash
DEFAULT_LABEL_MOCK_RUNTIME=none ./bin/set_env.sh \
  --data-input-path "/data/input" \
  --data-output-path "/data/output" \
  --agent-id "agent-001" \
  --knowledge "/data/knowledge/default_knowledge.json"
```

## `__init__.py` 的作用

`Default_Label/__init__.py` 里做了三件事：

1. 先尝试导入 `naie_logging` 和 `naie_http_client`。
2. naie 导入失败后，尝试导入 `fly_logging` 和 `fly_http_client`。
3. 封装统一的 `LLMClient`，对外只暴露 `call_llm(prompt)`。

业务代码里只需要：

```python
from . import LLMClient

llm_client = LLMClient()
llm_result = llm_client.call_llm("mock input text")
```

## `set_env.sh` 的执行链路

`set_env.sh` 会完成以下动作：

1. 解析并校验 `--data-input-path`、`--data-output-path`、`--agent-id`、`--knowledge`。
2. 自动定位算法包根目录和父目录。
3. export `Data_Input_Path`、`Data_Output_Path`、`AgentID`、`Knowledge`。
4. 本地 demo 根据 `DEFAULT_LABEL_MOCK_RUNTIME` 选择 mock runtime。
5. 通过 `python3 -m Default_Label.main` 启动主程序。

## 输出文件

结果文件写入：

```text
Default_Label/mock_data/output/result.json
```

结果结构包含：

- `success`
- `agent_id`
- `input_path`
- `output_path`
- `knowledge`
- `runtime`
- `label_result`

## 常见问题

### python3 找不到怎么办

安装 Python 3.9+，或通过 `PYTHON_BIN` 指定 Python 路径：

```bash
PYTHON_BIN=/path/to/python3 ./bin/set_env.sh ...
```

### 导入 SDK 失败怎么办

本地验证时确认 `DEFAULT_LABEL_MOCK_RUNTIME` 使用下面两个值之一：

```bash
DEFAULT_LABEL_MOCK_RUNTIME=online_naie
DEFAULT_LABEL_MOCK_RUNTIME=offline_fly
```

真实飞轮环境里确认 Python 环境已经提供对应的 logging 和 httpclient SDK。

### 权限不足怎么办

给入口脚本添加执行权限：

```bash
chmod +x bin/set_env.sh
```

### result.json 没生成怎么办

检查控制台日志中的错误信息，重点确认：

- `mock_data/input/input.json` 存在且是合法 JSON。
- `knowledge/default_knowledge.json` 存在且是合法 JSON。
- `mock_runtime/online_naie` 或 `mock_runtime/offline_fly` 路径存在。
- `mock_data/output` 所在路径有写入权限。
