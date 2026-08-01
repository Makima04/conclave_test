#!/usr/bin/env bash
# PR-13: G1 API smoke with mock LLM (no real provider / no browser).
#
# Exercises:
#   GET  /api/init
#   POST /api/chat  (mock echoes user_message; returns prompt_debug + new_state)
#
# Usage:
#   ./scripts/e2e-smoke.sh
#       Build + start backend on a free port (CONCLAVE_BIND), smoke, stop.
#   BASE_URL=http://127.0.0.1:3000 ./scripts/e2e-smoke.sh
#       Against an already-running server (does not start/stop).
#
# Exit 0 on success. Does not require frontend or API keys.
# Forces CONCLAVE_LLM_PROVIDER=mock for the spawned server.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND_DIR="$ROOT/backend"
BASE_URL="${BASE_URL:-}"
STARTED_SERVER=0
SERVER_PID=""
LOG_FILE=""

cleanup() {
  if [[ "$STARTED_SERVER" -eq 1 && -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "${LOG_FILE:-}" && -f "$LOG_FILE" ]]; then
    rm -f "$LOG_FILE"
  fi
}
trap cleanup EXIT

pick_free_port() {
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
  else
    echo "18765"
  fi
}

wait_for_http() {
  local url="$1"
  local attempts="${2:-80}"
  local i=0
  while (( i < attempts )); do
    if curl -sf "$url" >/dev/null 2>&1; then
      return 0
    fi
    # Bail early if the process died
    if [[ "$STARTED_SERVER" -eq 1 && -n "${SERVER_PID:-}" ]] && ! kill -0 "$SERVER_PID" 2>/dev/null; then
      return 1
    fi
    sleep 0.25
    i=$((i + 1))
  done
  return 1
}

# Read JSON body from stdin (card fixtures can be multi-MB — never pass as argv).
# Note: do NOT use a heredoc for python — it would replace the piped stdin.
check_init_stdin() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys
data=json.load(sys.stdin)
assert "session_epoch" in data, "session_epoch missing"
assert "regex_scripts" in data, "regex_scripts missing"
assert "card_name" in data or "first_message" in data
print("    card_name=%r session_epoch=%s" % (data.get("card_name"), data.get("session_epoch")))'
  else
    local tmp
    tmp="$(mktemp)"
    cat >"$tmp"
    grep -q 'session_epoch' "$tmp" || { rm -f "$tmp"; echo "!! missing session_epoch"; exit 1; }
    grep -q 'regex_scripts' "$tmp" || { rm -f "$tmp"; echo "!! missing regex_scripts"; exit 1; }
    rm -f "$tmp"
    echo "    init ok (grep checks)"
  fi
}

check_chat_stdin() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys
data=json.load(sys.stdin)
raw=data.get("raw_text") or ""
assert "e2e-smoke-ping" in raw, "mock must echo user message: %r" % (raw[:200],)
assert isinstance(data.get("new_state"), dict), "new_state object required"
pd=data.get("prompt_debug")
assert isinstance(pd, dict), "prompt_debug required"
assert "final_prompt" in pd or "base_prompt" in pd
print("    raw_text_len=%d prompt_debug_keys=%s" % (len(raw), list(pd.keys())))'
  else
    local tmp
    tmp="$(mktemp)"
    cat >"$tmp"
    grep -q 'e2e-smoke-ping' "$tmp" || { rm -f "$tmp"; echo "!! mock did not echo"; exit 1; }
    grep -q 'new_state' "$tmp" || { rm -f "$tmp"; echo "!! missing new_state"; exit 1; }
    rm -f "$tmp"
    echo "    chat ok (grep checks)"
  fi
}

if [[ -z "$BASE_URL" ]]; then
  PORT="$(pick_free_port)"
  BASE_URL="http://127.0.0.1:${PORT}"
  LOG_FILE="$(mktemp -t conclave-e2e-XXXXXX.log)"

  echo "==> Building backend"
  (cd "$BACKEND_DIR" && cargo build --quiet)

  echo "==> Starting mock backend on $BASE_URL (CONCLAVE_LLM_PROVIDER=mock)"
  (
    cd "$BACKEND_DIR"
    export CONCLAVE_LLM_PROVIDER=mock
    export CONCLAVE_BIND="127.0.0.1:${PORT}"
    unset CONCLAVE_LLM_BASE_URL || true
    unset CONCLAVE_LLM_API_KEY || true
    # Prefer already-built binary for faster start
    if [[ -x target/debug/cangxuan-engine ]]; then
      exec ./target/debug/cangxuan-engine
    fi
    exec cargo run --quiet
  ) >"$LOG_FILE" 2>&1 &
  SERVER_PID=$!
  STARTED_SERVER=1

  echo "==> Waiting for $BASE_URL/api/init (pid=$SERVER_PID)"
  if ! wait_for_http "$BASE_URL/api/init" 120; then
    echo "!! Server failed to become ready. Log tail:"
    tail -n 80 "$LOG_FILE" || true
    exit 1
  fi
else
  echo "==> Using existing server: $BASE_URL"
  if ! wait_for_http "$BASE_URL/api/init" 8; then
    echo "!! Cannot reach $BASE_URL/api/init"
    exit 1
  fi
fi

echo "==> GET /api/init"
curl -sf "$BASE_URL/api/init" | check_init_stdin

echo "==> POST /api/chat (mock)"
curl -sf -X POST "$BASE_URL/api/chat" \
  -H 'Content-Type: application/json' \
  -d '{"user_message":"e2e-smoke-ping","session_id":"smoke","client_mvu":{"stat_data":{},"initialized_lorebooks":{}},"injections":[]}' \
  | check_chat_stdin

echo "==> E2E smoke OK (mock G1 path)"
