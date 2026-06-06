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
        1) SCENARIO=s2 ;;      # Mon: PLC download storm
        2) SCENARIO=s3 ;;      # Tue: connectivity hell (cloud flap)
        3) SCENARIO=mutate ;;  # Wed: cloud-mutation (propagation + no wipe)
        4) SCENARIO=s1 ;;      # Thu: clean scale soak
        5) SCENARIO=s3 ;;      # Fri: connectivity hell
        6) SCENARIO=s6 ;;      # Sat: CIP saturation
        7) SCENARIO=mutate ;;  # Sun: cloud-mutation
    esac
fi

export RUN_ID="ci-${SCENARIO}-${CI_PIPELINE_ID:-local}"
export SOAK_MINUTES="${SOAK_MINUTES:-360}"
export BOTS="${BOTS:-6}"
export DOWNLOAD_STORM=""
export CLOUD_FLAP=""
DELAY_MS=""

case "$SCENARIO" in
    s1) ;;                                            # clean scale soak
    s2) export DOWNLOAD_STORM="20,40" ;;              # PLC program downloads
    s3) export CLOUD_FLAP="2,6"; export FLAP_BUDGET=60 ;;  # cloud connectivity hell
    s6) DELAY_MS=300 ;;                               # CIP-saturated controller
    mutate)                                           # cloud-side data changes
        export CLOUD_FLAP="3,12"; export FLAP_BUDGET=60
        export COMPOSE_PROFILES=mutate
        # Hot-set OFF: it's a B7 stress knob that bloats the queue and blocks
        # the propagation (I7) this scenario verifies (see FINDINGS F2).
        export HOT_FRACTION=0 ;;
    all)                                              # EVERYTHING at once (nightly)
        # PLC program downloads + cloud connectivity flap + cloud-side data
        # mutations + realistic tester load, all together — the harshest run.
        export DOWNLOAD_STORM="25,45"
        export CLOUD_FLAP="3,12"; export FLAP_BUDGET=120
        export COMPOSE_PROFILES=mutate; export MUTATE_PERIOD_SEC=240
        export BOTS="${BOTS:-5}"
        # HOT_FRACTION stays 0 here (as in the mutate scenario): the hot-set is a
        # synthetic queue-stress knob that (a) bloats PendingSyncs so the tool
        # never drains its queue and SKIPS cloud pulls — blinding I7 — and (b)
        # creates multi-writer last-write ambiguity that fakes I4 wipes. It
        # exercises no real field behavior; dropping it keeps the data-loss and
        # propagation verdicts trustworthy while ALL real chaos still runs. See
        # FINDINGS F2 + the mutate scenario.
        export HOT_FRACTION=0
        export THINK_MIN_MS=700; export THINK_MAX_MS=3000 ;;
    *) echo "unknown scenario $SCENARIO" >&2; exit 2 ;;
esac

echo "=== battle: scenario=$SCENARIO run=$RUN_ID soak=${SOAK_MINUTES}min ==="

if [ "${BATTLE_PULL:-0}" = "1" ]; then
    # CI path: PULL the 3 heavy images (tool/cloud/plc-sim) from the registry,
    # BUILD only the tiny python/node ones. Avoids the ci-runner disk blowout.
    echo "battle: pull mode — heavy images from registry, building tiny ones"
    BUILD_SVCS="seeder crew chaos observer"
    [ -n "$COMPOSE_PROFILES" ] && BUILD_SVCS="$BUILD_SVCS cloud-mutator"
    docker compose -f docker-compose.battle.yml -p battle build $BUILD_SVCS
    docker compose -f docker-compose.battle.yml -p battle up -d
else
    # Local path: build everything.
    docker compose -f docker-compose.battle.yml -p battle up --build -d
fi

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
