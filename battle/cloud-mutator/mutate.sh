#!/bin/sh
# cloud-mutator — simulates data changing/arriving on the CLOUD side that the
# field did not author: a coordinator editing in the cloud UI, another tablet
# syncing, or installation-tracker writing shared columns.
#
# Two modes (MUTATE_MODE):
#   sql  (default) — raw psql INSERT/UPDATE. Fast, but BYPASSES recordChange +
#                    the SSE hint, so it only exercises the full-pull catch-up
#                    (the original `mutate` scenario / I7).
#   api            — drives the REAL admin API (POST/DELETE /api/admin/ios) after
#                    a dev-admin sign-in, so the cloud fires recordChange (writes
#                    subsystem_change_log) + broadcastSubsystemChanged. This is
#                    the path the `delta` scenario + I11/I12/I13 verify. Requires
#                    a dev-mode cloud (DEV_BYPASS_AUTH=true).
#
# It never touches `result` on IOs the field is testing — that would be a
# legitimate last-write-wins conflict, separate from this scenario.
set -eu

MODE="${MUTATE_MODE:-sql}"
PERIOD="${MUTATE_PERIOD_SEC:-120}"
SUBSYSTEM_ID="${SUBSYSTEM_ID:-38}"
ADD_N="${MUTATE_ADD:-3}"
EDIT_N="${MUTATE_EDIT:-5}"
CLOUD_BASE="${CLOUD_BASE:-http://cloud:3000}"
RUN_DIR="/runs/${RUN_ID:-dev}"
JOURNAL="$RUN_DIR/cloud-mutations.jsonl"
STOP_FILE="$RUN_DIR/STOP"
PSQL="psql -h cloud-db -U battle -d commissioning -tAq"
export PGPASSWORD=battle
JAR=/tmp/cookies.txt
ADDED_IDS=/tmp/added_ids   # newline list of ids we created (for clean deletes)

mkdir -p "$RUN_DIR"
: > "$ADDED_IDS"

# Interruptible wait: the observer drops STOP at soak end so we add no rows in
# the verdict window (they'd have no time to propagate). Returns 1 to stop.
wait_period() {
  slept=0
  while [ "$slept" -lt "$PERIOD" ]; do
    [ -f "$STOP_FILE" ] && return 1
    sleep 5; slept=$((slept + 5))
  done
  [ -f "$STOP_FILE" ] && return 1 || return 0
}

journal() { echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"mode\":\"$MODE\",\"seq\":$1,\"added\":\"$2\",\"deleted\":\"$3\",\"edited\":\"$4\"}" >> "$JOURNAL"; }

# ── SQL mode (original) ──────────────────────────────────────────────────────
sql_loop() {
  until $PSQL -c "SELECT 1 FROM ios LIMIT 1" >/dev/null 2>&1; do sleep 3; done
  seq=0
  while wait_period; do
    seq=$((seq + 1)); stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    added="$($PSQL -c "WITH ins AS (INSERT INTO ios (subsystemid,name,description,version) SELECT ${SUBSYSTEM_ID},'CLOUDADD_${seq}_'||g,'added cloud-side',0 FROM generate_series(1,${ADD_N}) g RETURNING id) SELECT string_agg(id::text,',') FROM ins;")"
    edited="$($PSQL -c "WITH pick AS (SELECT id FROM ios WHERE subsystemid=${SUBSYSTEM_ID} ORDER BY id LIMIT ${EDIT_N} OFFSET (${seq}*${EDIT_N})), upd AS (UPDATE ios SET clarification_note='cloud-edit seq ${seq} ${stamp}' WHERE id IN (SELECT id FROM pick) RETURNING id) SELECT string_agg(id::text,',') FROM upd;")"
    journal "$seq" "$added" "" "$edited"
    echo "cloud-mutator[sql]: seq=$seq added=[$added] edited=[$edited]"
  done
  echo "cloud-mutator[sql]: STOP — exiting"
}

# ── API mode (drives recordChange + the SSE hint) ────────────────────────────
sign_in() {
  rm -f "$JAR"
  csrf="$(curl -s -c "$JAR" "$CLOUD_BASE/api/auth/csrf" | sed -n 's/.*"csrfToken":"\([^"]*\)".*/\1/p')"
  [ -n "$csrf" ] || return 1
  curl -s -b "$JAR" -c "$JAR" -X POST "$CLOUD_BASE/api/auth/callback/dev-admin" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "csrfToken=$csrf" --data-urlencode "json=true" -o /dev/null
  curl -s -b "$JAR" "$CLOUD_BASE/api/auth/session" | grep -q '"isAdmin":true'
}

add_io() {  # $1=name ; echoes new id
  curl -s -b "$JAR" -X POST "$CLOUD_BASE/api/admin/ios" -H "Content-Type: application/json" \
    -d "{\"name\":\"$1\",\"description\":\"added cloud-side via API\",\"subsystemId\":${SUBSYSTEM_ID}}" \
    | sed -n 's/.*"id":\([0-9]*\).*/\1/p'
}
del_io() { curl -s -b "$JAR" -X DELETE "$CLOUD_BASE/api/admin/ios/$1" -o /dev/null; }

api_loop() {
  echo "cloud-mutator[api]: waiting for cloud + dev-admin sign-in at $CLOUD_BASE ..."
  i=0; until sign_in; do i=$((i+1)); [ "$i" -gt 60 ] && { echo "cloud-mutator[api]: sign-in FAILED after 60 tries"; exit 1; }; sleep 5; done
  echo "cloud-mutator[api]: signed in as dev-admin"
  seq=0
  while wait_period; do
    seq=$((seq + 1)); added=""
    n=0
    while [ "$n" -lt "$ADD_N" ]; do
      n=$((n + 1))
      id="$(add_io "APIADD_${seq}_${n}")"
      if [ -n "$id" ]; then echo "$id" >> "$ADDED_IDS"; added="${added:+$added,}$id"; fi
    done
    # Every 2nd period, CLEAN-delete the oldest added IO (no local result) so
    # I12 can verify delete propagation. (The guarded-delete case — deleting an
    # IO with an un-pushed local result — is exercised separately.)
    deleted=""
    if [ $((seq % 2)) -eq 0 ]; then
      victim="$(head -n 1 "$ADDED_IDS" 2>/dev/null || true)"
      if [ -n "$victim" ]; then del_io "$victim"; deleted="$victim"; sed -i '1d' "$ADDED_IDS" 2>/dev/null || true; fi
    fi
    journal "$seq" "$added" "$deleted" ""
    echo "cloud-mutator[api]: seq=$seq added=[$added] deleted=[$deleted]"
  done
  echo "cloud-mutator[api]: STOP — exiting"
}

echo "cloud-mutator: mode=$MODE every ${PERIOD}s add ${ADD_N} (subsystem ${SUBSYSTEM_ID})"
case "$MODE" in
  api) api_loop ;;
  *)   sql_loop ;;
esac
