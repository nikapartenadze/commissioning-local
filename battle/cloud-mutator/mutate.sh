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

# crud-propagation journal line: one row per data type the field PULLS, so the
# observer (I14-I17) knows the exact cloud value/version it must find locally.
# kind ∈ {vfd_addressed, l2_cell, estop_zone, network_ring}.
crud_journal() {  # $1=seq $2=subsystemId $3=kind $4=key $5=value $6=version
  printf '{"ts":"%s","mode":"crud","kind":"%s","seq":%s,"subsystemId":%s,"key":"%s","value":"%s","version":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$3" "$1" "$2" "$4" "$5" "${6:-0}" >> "$JOURNAL"
}

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

# ── CRUD mode (cloud→field definition/CRUD propagation: I14-I17) ──────────────
# Edits the four data types the field PULLS (not the result path): a belt VFD
# blocker marked ADDRESSED, an L2/FV cell value+version, an e-stop zone/EPC, and
# a network ring/port. Raw psql (SQL mode) keyed to the seeder's per-MCM CRUD
# rows (CRUD_BASE=9000000, offset by subsystemId). The observer drives the
# field's scoped pull and verifies arrival. NEVER touches IO `result`.
#
# CRUD_BASE must match battle/seeder/seed.py.
CRUD_BASE=9000000
crud_loop() {
  until $PSQL -c "SELECT 1 FROM ios LIMIT 1" >/dev/null 2>&1; do sleep 3; done
  off=$((CRUD_BASE + SUBSYSTEM_ID))   # per-MCM seeded id for this subsystem
  seq=0
  while wait_period; do
    seq=$((seq + 1)); stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    # (a) VFD ADDRESSED — mark the seeded belt blocker addressed (cloud-only
    #     handoff; the GET /api/sync/vfd-addressed pull mirrors it into the
    #     field's VfdAddressed table). device_name is the I14 key.
    bname="CBT_CRUD_${SUBSYSTEM_ID}_VFD"
    $PSQL -c "UPDATE \"VfdCommissioningBlocker\" SET addressed_at = now(), addressed_by = 'battle-mechanic' WHERE device_id = ${off};" >/dev/null 2>&1 || true
    crud_journal "$seq" "$SUBSYSTEM_ID" "vfd_addressed" "$bname" "1" "0"

    # (b) L2/FV cell — bump value + version so the cloud is strictly newer than
    #     the field's seeded v1 (version-gated LWW must apply it). key = the
    #     cloud cell id; value/version are what the field cell must converge to.
    newver=$((seq + 2))   # seeded cell is v1; always strictly newer
    val="crud-${seq}"
    $PSQL -c "UPDATE l2_cell_values SET value = '${val}', version = ${newver}, updated_at = now() WHERE id = ${off};" >/dev/null 2>&1 || true
    crud_journal "$seq" "$SUBSYSTEM_ID" "l2_cell" "${off}" "$val" "$newver"

    # (c) E-stop zone — rename the seeded zone; the field's pull-estop rebuilds
    #     the tree, so I16 expects this zone name AND other MCMs' zones intact.
    zname="CRUD_ZONE_${SUBSYSTEM_ID}_v${seq}"
    $PSQL -c "UPDATE estop_zones SET name = '${zname}' WHERE id = ${off};" >/dev/null 2>&1 || true
    crud_journal "$seq" "$SUBSYSTEM_ID" "estop_zone" "$zname" "$zname" "0"

    # (d) Network ring — rename the seeded ring + add a port label; pull-network
    #     cascade-replaces this subsystem's chain. I17 expects the new name and
    #     no cross-MCM wipe.
    rname="CRUD_RING_${SUBSYSTEM_ID}_v${seq}"
    $PSQL -c "UPDATE network_rings SET name = '${rname}' WHERE id = ${off};" >/dev/null 2>&1 || true
    $PSQL -c "UPDATE network_ports SET device_name = 'CRUD_PORT_${SUBSYSTEM_ID}_v${seq}' WHERE id = ${off};" >/dev/null 2>&1 || true
    crud_journal "$seq" "$SUBSYSTEM_ID" "network_ring" "$rname" "$rname" "0"

    echo "cloud-mutator[crud]: seq=$seq subsystem=$SUBSYSTEM_ID addressed=$bname l2=$val/$newver zone=$zname ring=$rname"
  done
  echo "cloud-mutator[crud]: STOP — exiting"
}

echo "cloud-mutator: mode=$MODE every ${PERIOD}s add ${ADD_N} (subsystem ${SUBSYSTEM_ID})"
case "$MODE" in
  api)  api_loop ;;
  crud) crud_loop ;;
  *)    sql_loop ;;
esac
