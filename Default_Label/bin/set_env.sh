#!/usr/bin/env bash

# 开启严格模式：
# -e: 任意命令失败时立即退出，避免后续步骤继续使用错误状态。
# -u: 使用未定义变量时报错，避免参数名写错后静默执行。
# -o pipefail: 管道中任意一步失败时整体失败，方便外部 Job 感知异常。
set -euo pipefail

# 打印脚本使用说明。
# 参数入口统一使用命名参数，方便 K8s Job 或外部服务清晰传值。
usage() {
  cat <<'EOF'
Usage:
  set_env.sh \
    --data-input-path <path> \
    --data-output-path <path> \
    --agent-id <agent-id> \
    --knowledge <path>

Example:
  ./bin/set_env.sh \
    --data-input-path "./mock_data/input" \
    --data-output-path "./mock_data/output" \
    --agent-id "agent-001" \
    --knowledge "./knowledge/default_knowledge.json"
EOF
}

# 输出错误信息、展示 usage，并使用退出码 2 表示参数或前置条件错误。
# 所有参数校验失败、未知参数、SDK 文件缺失都会走这里。
error() {
  echo "[set_env.sh] ERROR: $*" >&2
  echo >&2
  usage >&2
  exit 2
}

# 将用户传入的路径转换为绝对路径。
# 绝对路径原样返回；相对路径基于调用脚本时所在目录 CALLER_DIR 拼接。
# 这样支持从任意目录执行 /xxx/Default_Label/bin/set_env.sh。
resolve_path() {
  local path="$1"
  if [[ "$path" = /* ]]; then
    printf '%s\n' "$path"
  else
    printf '%s/%s\n' "$CALLER_DIR" "$path"
  fi
}

# 先声明 4 个业务参数变量。
# 后续 while/case 解析命名参数时逐个赋值。
DATA_INPUT_PATH=""
DATA_OUTPUT_PATH=""
AGENT_ID=""
KNOWLEDGE=""

# 解析命名参数。
# 每个参数都要求后面带一个值，读取后 shift 2 消费参数名和值。
# 支持 -h/--help 打印帮助信息。
while [[ $# -gt 0 ]]; do
  case "$1" in
    --data-input-path)
      [[ $# -ge 2 ]] || error "missing value for --data-input-path"
      DATA_INPUT_PATH="$2"
      shift 2
      ;;
    --data-output-path)
      [[ $# -ge 2 ]] || error "missing value for --data-output-path"
      DATA_OUTPUT_PATH="$2"
      shift 2
      ;;
    --agent-id)
      [[ $# -ge 2 ]] || error "missing value for --agent-id"
      AGENT_ID="$2"
      shift 2
      ;;
    --knowledge)
      [[ $# -ge 2 ]] || error "missing value for --knowledge"
      KNOWLEDGE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      error "unknown argument: $1"
      ;;
  esac
done

# 校验 4 个必要参数已经传入。
# 这一步在 export 环境变量前执行，保证 main.py 读取到完整配置。
[[ -n "$DATA_INPUT_PATH" ]] || error "--data-input-path is required"
[[ -n "$DATA_OUTPUT_PATH" ]] || error "--data-output-path is required"
[[ -n "$AGENT_ID" ]] || error "--agent-id is required"
[[ -n "$KNOWLEDGE" ]] || error "--knowledge is required"

# 自动定位算法包目录。
# SCRIPT_DIR 是当前脚本所在目录 bin。
# PACKAGE_ROOT 是算法包根目录 Default_Label。
# PACKAGE_PARENT 是算法包父目录，用于 python -m Default_Label.main。
# CALLER_DIR 是用户执行脚本时所在目录，用来解析相对路径参数。
# PYTHON_BIN 默认使用 python3，也允许外部通过 PYTHON_BIN=/path/to/python 覆盖。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PACKAGE_PARENT="$(cd "$PACKAGE_ROOT/.." && pwd)"
PACKAGE_NAME="$(basename "$PACKAGE_ROOT")"
CALLER_DIR="$(pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
DEFAULT_LABEL_MOCK_RUNTIME="${DEFAULT_LABEL_MOCK_RUNTIME:-online_naie}"

# 将输入目录、输出目录、知识文件路径统一转为绝对路径。
# main.py 后续直接使用这些环境变量，避免 cd 到算法包根目录后相对路径失效。
DATA_INPUT_PATH="$(resolve_path "$DATA_INPUT_PATH")"
DATA_OUTPUT_PATH="$(resolve_path "$DATA_OUTPUT_PATH")"
KNOWLEDGE="$(resolve_path "$KNOWLEDGE")"

# 本地 demo 用 mock_runtime 模拟在线/离线飞轮环境里已经存在的 SDK。
# DEFAULT_LABEL_MOCK_RUNTIME=online_naie 表示模拟在线飞轮 naie 依赖。
# DEFAULT_LABEL_MOCK_RUNTIME=offline_fly 表示模拟离线飞轮 fly 依赖。
# DEFAULT_LABEL_MOCK_RUNTIME=none 表示使用真实 Python 环境里已经提供的 SDK。
if [[ "$DEFAULT_LABEL_MOCK_RUNTIME" != "none" ]]; then
  MOCK_RUNTIME_DIR="$PACKAGE_ROOT/mock_runtime/$DEFAULT_LABEL_MOCK_RUNTIME"
  [[ -d "$MOCK_RUNTIME_DIR" ]] || error "mock runtime not found: $MOCK_RUNTIME_DIR"
  export PYTHONPATH="$MOCK_RUNTIME_DIR${PYTHONPATH:+:$PYTHONPATH}"
fi

# 导出 main.py 依赖的 4 个环境变量。
# 变量名保持和旧算法包一致，让 main.py 继续通过 os.getenv 读取。
export Data_Input_Path="$DATA_INPUT_PATH"
export Data_Output_Path="$DATA_OUTPUT_PATH"
export AgentID="$AGENT_ID"
export Knowledge="$KNOWLEDGE"

# 打印关键运行日志。
# 日志用于本地验证，也方便 K8s Job 日志中定位路径、Python 和参数问题。
echo "[set_env.sh] package root: $PACKAGE_ROOT"
echo "[set_env.sh] package parent: $PACKAGE_PARENT"
echo "[set_env.sh] python: $PYTHON_BIN"
echo "[set_env.sh] mock runtime: $DEFAULT_LABEL_MOCK_RUNTIME"
echo "[set_env.sh] Data_Input_Path: $Data_Input_Path"
echo "[set_env.sh] Data_Output_Path: $Data_Output_Path"
echo "[set_env.sh] AgentID: $AgentID"
echo "[set_env.sh] starting main.py"

# 进入算法包父目录后，通过 -m 方式启动 Default_Label.main。
# 这种方式会先加载 Default_Label/__init__.py，完成 SDK 适配逻辑。
# exec 会用 Python 进程替换当前 Shell 进程，让 main.py 的退出码直接返回给外部调用方。
cd "$PACKAGE_PARENT"
exec "$PYTHON_BIN" -m "$PACKAGE_NAME.main"
