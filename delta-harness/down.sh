#!/usr/bin/env bash
# Tear down the delta-sync harness stack.
set -uo pipefail
kill_port(){ local P=$1; local PID; PID=$(netstat -ano 2>/dev/null | grep -E ":$P .*LISTENING" | awk '{print $NF}' | head -1 || true); [ -n "${PID:-}" ] && taskkill //F //PID "$PID" >/dev/null 2>&1 && echo "  killed :$P (pid $PID)" || true; }
echo "[harness] tearing down..."
kill_port 3003   # cloud dev
kill_port 3030   # field server
docker rm -f delta-harness-pg >/dev/null 2>&1 && echo "  removed postgres" || true
echo "[harness] DOWN."
