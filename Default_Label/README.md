# Default Label Mock Project

这是一个本地可运行的 Python mock 项目，用来验证 Default Label 算法包从环境变量预置模式改造为 `bin/set_env.sh` 参数入口模式的执行链路。

## 目录结构

```text
Default_Label/
├── bin/
│   └── set_env.sh
├── lib/
│   ├── naie_api-23.3.3.tar.gz
│   └── naie_impl_network-23.1.1.1.tar.gz
├── knowledge/
│   └── default_knowledge.json
├── template/
│   └── default_template.txt
├── mock_data/
│   ├── input/
│   │   └── input.json
│   └── output/
├── scripts/
│   └── build_mock_sdks.py
├── default_label_util.py
├── knowledge_manager.py
├── main.py
├── plugin.yaml
└── README.md
```

## 环境要求

推荐使用 Python 3.9+。macOS / Linux 默认 bash 环境即可运行。

## 运行步骤

进入项目目录：

```bash
cd Default_Label
```

生成 mock SDK 包：

```bash
python3 scripts/build_mock_sdks.py
```

给入口脚本加执行权限：

```bash
chmod +x bin/set_env.sh
```

执行算法包：

```bash
./bin/set_env.sh \
  --data-input-path "./mock_data/input" \
  --data-output-path "./mock_data/output" \
  --agent-id "agent-001" \
  --knowledge "./knowledge/default_knowledge.json"
```

查看输出结果：

```bash
cat mock_data/output/result.json
```

输出文件位置：

```text
Default_Label/mock_data/output/result.json
```

## 执行链路

`set_env.sh` 会完成以下动作：

1. 解析并校验 `--data-input-path`、`--data-output-path`、`--agent-id`、`--knowledge`。
2. 自动定位算法包根目录和 `lib` 目录。
3. export `Data_Input_Path`、`Data_Output_Path`、`AgentID`、`Knowledge`。
4. 使用当前 Python 依次安装 `naie_api-23.3.3.tar.gz` 和 `naie_impl_network-23.1.1.1.tar.gz`。
5. 进入算法包根目录，并通过 `exec "$PYTHON_BIN" "$PACKAGE_ROOT/main.py"` 启动主程序。

## 常见问题

### python3 找不到怎么办

安装 Python 3.9+，或通过 `PYTHON_BIN` 指定 Python 路径：

```bash
PYTHON_BIN=/path/to/python3 ./bin/set_env.sh ...
```

### pip 不可用怎么办

确认当前 Python 带有 pip：

```bash
python3 -m pip --version
```

如果不可用，执行：

```bash
python3 -m ensurepip --upgrade
```

### SDK 文件不存在怎么办

重新生成 mock SDK：

```bash
python3 scripts/build_mock_sdks.py
```

生成后的文件应位于：

```text
lib/naie_api-23.3.3.tar.gz
lib/naie_impl_network-23.1.1.1.tar.gz
```

### 权限不足怎么办

给入口脚本添加执行权限：

```bash
chmod +x bin/set_env.sh
```

### result.json 没生成怎么办

检查控制台日志中的错误信息，重点确认：

- `mock_data/input/input.json` 存在且是合法 JSON。
- `knowledge/default_knowledge.json` 存在且是合法 JSON。
- 两个 SDK tar.gz 已生成。
- `mock_data/output` 所在路径有写入权限。
