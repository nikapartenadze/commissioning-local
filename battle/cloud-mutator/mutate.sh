#!/bin/sh
# cloud-mutator — simulates data changing/arriving on the CLOUD side that the
# field did not author: a coordinator editing in the cloud UI, another tablet
# syncing, or installation-tracker writing shared columns. The field must pick
# these up (via the SSE-reconnect pull) WITHOUT re-pulling needlessly and
# WITHOUT wiping its own local results — the MCM08/MCM11 class.
#
# Every PERIOD seconds it:
#   1. adds a few brand-new IOs to the cloud subsystem (new ids)
#   2. edits cloud-owned fields on existing IOs (clarification_note)
#   3. journals what it changed so the observer can verify propagation
#
# It deliberately does NOT touch `result` on IOs the field is testing — that
# would be a legitimate last-write-wins conflict, separate from this scenario.
set -eu

PERIOD="${MUTATE_PERIOD_SEC:-120}"
SUBSYSTEM_ID="${SUBSYSTEM_ID:-38}"
ADD_N="${MUTATE_ADD:-3}"
EDIT_N="${MUTATE_EDIT:-5}"
JOURNAL="/runs/${RUN_ID:-dev}/cloud-mutations.jsonl"
PSQL="psql -h cloud-db -U battle -d commissioning -tAq"
export PGPASSWORD=battle

mkdir -p "$(dirname "$JOURNAL")"
echo "cloud-mutator: every ${PERIOD}s add ${ADD_N} IOs + edit ${EDIT_N} clarifications (subsystem ${SUBSYSTEM_ID})"

# Wait for the seed to have populated cloud.
until $PSQL -c "SELECT 1 FROM ios LIMIT 1" >/dev/null 2>&1; do sleep 3; done

seq=0
while true; do
    sleep "$PERIOD"
    seq=$((seq + 1))
    stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    # 1. add new IOs cloud-side (ids auto from sequence, kept ahead by the seed)
    added="$($PSQL -c "
        WITH ins AS (
          INSERT INTO ios (subsystemid, name, description, version)
          SELECT ${SUBSYSTEM_ID}, 'CLOUDADD_${seq}_' || g, 'added cloud-side', 0
          FROM generate_series(1, ${ADD_N}) g
          RETURNING id
        ) SELECT string_agg(id::text, ',') FROM ins;")"

    # 2. edit cloud-owned clarification on a random sample of existing IOs
    edited="$($PSQL -c "
        WITH pick AS (
          SELECT id FROM ios WHERE subsystemid = ${SUBSYSTEM_ID}
          ORDER BY id LIMIT ${EDIT_N} OFFSET (${seq} * ${EDIT_N})
        ), upd AS (
          UPDATE ios SET clarification_note = 'cloud-edit seq ${seq} ${stamp}'
          WHERE id IN (SELECT id FROM pick) RETURNING id
        ) SELECT string_agg(id::text, ',') FROM upd;")"

    echo "{\"ts\":\"${stamp}\",\"seq\":${seq},\"added\":\"${added}\",\"edited\":\"${edited}\"}" >> "$JOURNAL"
    echo "cloud-mutator: seq=${seq} added=[${added}] edited=[${edited}]"
done
