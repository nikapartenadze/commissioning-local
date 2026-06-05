#!/bin/sh
# GitLab CI battle-run driver. Runs inside a docker:cli job against the DinD
# service daemon. Picks the scenario, runs the stack, waits for the observer
# verdict, and exports artifacts from the named runs volume.
#
# Env in:
#   SCENARIO       s1 | s2 | s6 | auto   (auto = weekday rotation)
#   SOAK_MINUTES   override run length (CI schedule sets 360 = 00:30->06:30,
#                  clear of work-hours builds on the shared dind runner)
#   CI_PIPELINE_ID / CI_PROJECT_DIR  (GitLab built-ins)
set -eu

cd "$(dirname "$0")/.."   # battle/

SCENARIO="${SCENARIO:-auto}"
if [ "$SCENARIO" = "auto" ]; then
    case "$(date +%u)" in
        1|3|5) SCENARIO=s2 ;;  # Mon/Wed/Fri: download storm
        2|4)   SCENARIO=s1 ;;  # Tue/Thu:     clean scale soak
        6)     SCENARIO=s6 ;;  # Sat:         CIP saturation
        7)     SCENARIO=s2 ;;  # Sun:         storm again
    esac
fi

export RUN_ID="ci-${SCENARIO}-${CI_PIPELINE_ID:-local}"
export SOAK_MINUTES="${SOAK_MINUTES:-360}"
export BOTS="${BOTS:-6}"
export DOWNLOAD_STORM=""
DELAY_MS=""

case "$SCENARIO" in
    s1) ;;
    s2) export DOWNLOAD_STORM="20,40" ;;
    s6) DELAY_MS=300 ;;
    *) echo "unknown scenario $SCENARIO" >&2; exit 2 ;;
esac

echo "=== battle: scenario=$SCENARIO run=$RUN_ID soak=${SOAK_MINUTES}min ==="

docker compose -f docker-compose.battle.yml -p battle up --build -d

# CIP-saturation profile: write the delay file into the gen volume and bounce
# the sim once so its entrypoint picks it up (counts as one injected event in
# spirit; budget it).
if [ -n "$DELAY_MS" ]; then
    sleep 20  # let the seeder finish + first boot settle
    docker exec battle-chaos-1 python -c "
import urllib.request
print(urllib.request.urlopen(urllib.request.Request('http://localhost:8666/delay?ms=${DELAY_MS}', method='POST')).read().decode())"
    export FLAP_BUDGET=2
fi

echo "=== waiting for observer verdict (${SOAK_MINUTES} min)... ==="
EXIT_CODE="$(docker wait battle-observer-1)"
echo "=== observer exit: $EXIT_CODE ==="

# Export artifacts from the named volume + tool logs for the record.
OUT="${CI_PROJECT_DIR:-$(pwd)}/battle-artifacts"
mkdir -p "$OUT"
docker cp "battle-observer-1:/runs/$RUN_ID" "$OUT/" || true
docker cp battle-tool-1:/data/logs "$OUT/tool-logs" || true
docker logs battle-tool-1 > "$OUT/tool-console.log" 2>&1 || true

echo "=== verdict ==="
cat "$OUT/$RUN_ID/verdict.json" 2>/dev/null || echo "(no verdict written)"

docker compose -p battle down -v || true
exit "$EXIT_CODE"
