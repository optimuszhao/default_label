# Default Label Mock Project

这是一个本地可运行的 Python mock 项目，用来验证 Default Label 算法包在在线飞轮和离线飞轮两种环境里的 SDK 适配方案。

核心设计：

- 外部服务负责拉起算法包进程，并提前在虚拟环境里注入环境变量。
- `Default_Label/__init__.py` 负责自动识别 SDK 环境，并统一封装 `LLMClient`。
- 业务代码统一调用 `LLMClient.call_llm()`，业务流程保持稳定。
- 本地 mock runtime 用来模拟在线飞轮的 `naie` 依赖和离线飞轮的 `fly` 依赖。

## 目录结构

```text
Default_Label/
├── __init__.py
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

推荐使用 Python 3.9+。真实飞轮环境由外部服务准备虚拟环境、SDK 依赖和环境变量。

算法包读取 4 个环境变量：

```text
Data_Input_Path
Data_Output_Path
AgentID
Knowledge
```

## 本地运行在线飞轮 mock

从仓库根目录执行：

```bash
PYTHONPATH="./Default_Label/mock_runtime/online_naie" \
Data_Input_Path="./Default_Label/mock_data/input" \
Data_Output_Path="./Default_Label/mock_data/output" \
AgentID="agent-001" \
Knowledge="./Default_Label/knowledge/default_knowledge.json" \
python3 -m Default_Label.main
```

查看输出：

```bash
cat Default_Label/mock_data/output/result.json
```

输出里会看到：

```json
"runtime": {
  "sdk_name": "naie",
  "logging_sdk": "naie_logging",
  "http_client_sdk": "naie_http_client"
}
```

## 本地运行离线飞轮 mock

从仓库根目录执行：

```bash
PYTHONPATH="./Default_Label/mock_runtime/offline_fly" \
Data_Input_Path="./Default_Label/mock_data/input" \
Data_Output_Path="./Default_Label/mock_data/output" \
AgentID="agent-001" \
Knowledge="./Default_Label/knowledge/default_knowledge.json" \
python3 -m Default_Label.main
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

真实在线/离线飞轮环境里，外部服务负责：

1. 创建或选择 Python 虚拟环境。
2. 保证虚拟环境里存在对应的 logging 和 httpclient SDK。
3. 注入 `Data_Input_Path`、`Data_Output_Path`、`AgentID`、`Knowledge`。
4. 启动算法包主程序。

推荐启动命令：

```bash
python3 -m Default_Label.main
```

兼容脚本启动命令：

```bash
python3 Default_Label/main.py
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

## `main.py` 的执行链路

`main.py` 会完成以下动作：

1. 从环境变量读取 `Data_Input_Path`、`Data_Output_Path`、`AgentID`、`Knowledge`。
2. 读取 `input.json` 输入数据。
3. 读取知识配置 JSON。
4. 初始化 `LLMClient`，自动命中 naie 或 fly SDK。
5. 通过 `LLMClient.call_llm()` 处理每条输入记录。
6. 写入 `result.json`。

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

安装 Python 3.9+，或让外部服务使用明确的 Python 路径：

```bash
/path/to/python3 -m Default_Label.main
```

### 环境变量缺失怎么办

确认外部服务已经注入这 4 个环境变量：

```text
Data_Input_Path
Data_Output_Path
AgentID
Knowledge
```

### 导入 SDK 失败怎么办

本地验证时确认 `PYTHONPATH` 指向对应 mock runtime：

```bash
PYTHONPATH="./Default_Label/mock_runtime/online_naie"
PYTHONPATH="./Default_Label/mock_runtime/offline_fly"
```

真实飞轮环境里确认 Python 虚拟环境已经提供对应的 logging 和 httpclient SDK。

### result.json 没生成怎么办

检查控制台日志中的错误信息，重点确认：

- `Data_Input_Path/input.json` 存在且是合法 JSON。
- `Knowledge` 指向的知识文件存在且是合法 JSON。
- `Data_Output_Path` 所在路径有写入权限。
