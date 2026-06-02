#!/usr/bin/env bash
set -euo pipefail

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

error() {
  echo "[set_env.sh] ERROR: $*" >&2
  echo >&2
  usage >&2
  exit 2
}

resolve_path() {
  local path="$1"
  if [[ "$path" = /* ]]; then
    printf '%s\n' "$path"
  else
    printf '%s/%s\n' "$CALLER_DIR" "$path"
  fi
}

DATA_INPUT_PATH=""
DATA_OUTPUT_PATH=""
AGENT_ID=""
KNOWLEDGE=""

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

[[ -n "$DATA_INPUT_PATH" ]] || error "--data-input-path is required"
[[ -n "$DATA_OUTPUT_PATH" ]] || error "--data-output-path is required"
[[ -n "$AGENT_ID" ]] || error "--agent-id is required"
[[ -n "$KNOWLEDGE" ]] || error "--knowledge is required"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB_DIR="$PACKAGE_ROOT/lib"
CALLER_DIR="$(pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"

DATA_INPUT_PATH="$(resolve_path "$DATA_INPUT_PATH")"
DATA_OUTPUT_PATH="$(resolve_path "$DATA_OUTPUT_PATH")"
KNOWLEDGE="$(resolve_path "$KNOWLEDGE")"

NAIE_API_SDK="$LIB_DIR/naie_api-23.3.3.tar.gz"
NAIE_IMPL_NETWORK_SDK="$LIB_DIR/naie_impl_network-23.1.1.1.tar.gz"

[[ -f "$NAIE_API_SDK" ]] || error "SDK file not found: $NAIE_API_SDK. Run: cd \"$PACKAGE_ROOT\" && $PYTHON_BIN scripts/build_mock_sdks.py"
[[ -f "$NAIE_IMPL_NETWORK_SDK" ]] || error "SDK file not found: $NAIE_IMPL_NETWORK_SDK. Run: cd \"$PACKAGE_ROOT\" && $PYTHON_BIN scripts/build_mock_sdks.py"

export Data_Input_Path="$DATA_INPUT_PATH"
export Data_Output_Path="$DATA_OUTPUT_PATH"
export AgentID="$AGENT_ID"
export Knowledge="$KNOWLEDGE"

echo "[set_env.sh] package root: $PACKAGE_ROOT"
echo "[set_env.sh] python: $PYTHON_BIN"
echo "[set_env.sh] Data_Input_Path: $Data_Input_Path"
echo "[set_env.sh] Data_Output_Path: $Data_Output_Path"
echo "[set_env.sh] AgentID: $AgentID"
echo "[set_env.sh] SDK installation started"

"$PYTHON_BIN" -m pip install \
  --disable-pip-version-check \
  --no-cache-dir \
  --no-index \
  --find-links "$LIB_DIR" \
  "$LIB_DIR/naie_api-23.3.3.tar.gz"

"$PYTHON_BIN" -m pip install \
  --disable-pip-version-check \
  --no-cache-dir \
  --no-index \
  --find-links "$LIB_DIR" \
  "$LIB_DIR/naie_impl_network-23.1.1.1.tar.gz"

echo "[set_env.sh] SDK installation completed"
echo "[set_env.sh] starting main.py"

cd "$PACKAGE_ROOT"
exec "$PYTHON_BIN" "$PACKAGE_ROOT/main.py"
