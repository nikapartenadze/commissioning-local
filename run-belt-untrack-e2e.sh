#!/usr/bin/env bash
# Cross-process E2E runner for the belt-untrack safety loop.
#
# Brings up a REAL local cloud (battle/cloud:local) + throwaway Postgres, runs
# the live test (__tests__/e2e-belt-untrack-live.test.ts), and TEARS THE STACK
# DOWN afterwards. Re-runnable; the test re-seeds the DB idempotently each run.
#
# Prereqs:
#   - Docker running.
#   - The cloud image built from the e2e-cloud worktree:
#       docker build -t battle/cloud:local \
#         "<repo>/commissioning-cloud/.claude/worktrees/e2e-cloud"
#   - frontend/node_modules present (npm ci in frontend/, OR a junction to
#     commissioning-local/frontend/node_modules).
#
# Usage:  ./run-belt-untrack-e2e.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE="$ROOT/local-cloud.compose.yml"
FRONTEND="$ROOT/frontend"
CLOUD_URL="http://localhost:13001"

cleanup() {
  echo ">> Tearing down the compose stack (down -v)…"
  docker compose -f "$COMPOSE" down -v || true
}
trap cleanup EXIT

echo ">> Bringing the local cloud up…"
docker compose -f "$COMPOSE" up -d

echo ">> Waiting for the cloud to become healthy…"
for i in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$CLOUD_URL/api/health" 2>/dev/null || true)"
  if [ "$code" = "200" ]; then echo "   cloud healthy after ${i}s"; break; fi
  sleep 2
  if [ "$i" = "60" ]; then echo "!! cloud never became healthy"; exit 1; fi
done

echo ">> Running the belt-untrack E2E test (seeds the DB itself)…"
cd "$FRONTEND"
node node_modules/vitest/vitest.mjs run __tests__/e2e-belt-untrack-live.test.ts --disable-console-intercept
