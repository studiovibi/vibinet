#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="vibi"
REMOTE_DIR="~/rooms"

echo "[DEPLOY] Syncing repo to ${REMOTE_HOST}:${REMOTE_DIR}"

rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.DS_Store' \
  ./ "${REMOTE_HOST}:${REMOTE_DIR}/"

echo "[DEPLOY] Restarting remote server"
ssh -T "${REMOTE_HOST}" bash -lc "\
  set -euo pipefail; \
  mkdir -p ${REMOTE_DIR}; \
  cd ${REMOTE_DIR}; \
  # Stop previous server if pid file exists or process matches
  if [ -f server.pid ]; then \
    kill \$(cat server.pid) 2>/dev/null || true; \
    rm -f server.pid; \
  fi; \
  pkill -f 'bun run server' 2>/dev/null || true; \
  # Install deps and start fresh server
  bun install; \
  nohup bun run server > server.log 2>&1 & echo \$! > server.pid; \
  disown || true; \
  echo '[DEPLOY] Server started (PID:' \$(cat server.pid) ')'; \
"

echo "[DEPLOY] Done"

