#!/usr/bin/env bash
# Starts the desk in DRY_RUN with a temp data dir and exercises the whole pipeline.
# Uses throwaway test secrets only. Makes NO external network calls.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${SMOKE_PORT:-3199}"
DATA="$(mktemp -d)"
LOG="$DATA/server.log"
export PORT DATA_DIR="$DATA" DRY_RUN=1
export DESK_INGEST_SECRET="smoke-ingest-secret" DESK_OWNER_PIN="9090" DESK_SESSION_SECRET="smoke-session-secret"
export TELEGRAM_CHAT_ID="1000001"   # dummy; DRY_RUN=1 means nothing is sent
unset TELEGRAM_BOT_TOKEN || true
node src/server.js >"$LOG" 2>&1 &
PID=$!
cleanup() { kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; rm -rf "$DATA"; }
trap cleanup EXIT
for _ in $(seq 1 50); do curl -fs "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 0.2; done
SMOKE_BASE="http://127.0.0.1:$PORT" node scripts/smoke.js
echo "--- server log (dry-run notifications) ---"
grep -c 'notify:dry-run' "$LOG" | sed 's/^/dry-run notifications logged: /'
if grep -q 'api.telegram.org' "$LOG"; then echo "FAIL: unexpected telegram call"; exit 1; fi
