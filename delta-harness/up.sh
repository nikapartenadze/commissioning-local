#!/usr/bin/env bash
# Delta-sync integration harness — bring up the REAL stack on this device:
#   throwaway Postgres + commissioning-cloud (dev mode, auth-bypass) + the real
#   field server (server-express) pointed at the dev cloud via CLOUD_URL_OVERRIDE.
#
# This exercises the ACTUAL production path the battle rig can't reach (admin API
# -> recordChange -> SSE subsystem_changed hint -> field delta apply), because
# DEV_BYPASS_AUTH lets the scenario runner drive the session-authed admin API.
#
# Idempotent: re-running tears down the previous stack first. Children are
# nohup+disown'd so they survive this script's exit (run.mjs talks to them;
# down.sh stops them).
set -uo pipefail
H="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$H/.." && pwd)"                 # commissioning-local
CLOUD="$ROOT/../commissioning-cloud"
FE="$ROOT/frontend"
RUN="$H/.run"; mkdir -p "$RUN"
# Windows-style path for values handed to Windows Node (better-sqlite3 / config),
# while $RUN stays MSYS-style for bash file ops.
WRUN="$(cygpath -m "$RUN" 2>/dev/null || echo "$RUN")"

PG=delta-harness-pg
PGPORT=5440
CLOUD_PORT=3003
FIELD_PORT=3030
FIELD_WS=3032
DBURL="postgresql://dev:dev@localhost:$PGPORT/commissioning"

kill_port(){ local P=$1; local PID; PID=$(netstat -ano 2>/dev/null | grep -E ":$P .*LISTENING" | awk '{print $NF}' | head -1 || true); [ -n "${PID:-}" ] && taskkill //F //PID "$PID" >/dev/null 2>&1 || true; }

echo "[harness] cleaning previous run..."
kill_port $CLOUD_PORT; kill_port $FIELD_PORT
docker rm -f $PG >/dev/null 2>&1 || true
rm -f "$RUN/field.db" "$RUN/field.db-wal" "$RUN/field.db-shm" "$RUN/cloud.log" "$RUN/field.log"

echo "[harness] postgres on $PGPORT..."
docker run -d --name $PG -e POSTGRES_USER=dev -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=commissioning -p $PGPORT:5432 postgres:14-alpine >/dev/null
for i in $(seq 1 30); do docker exec $PG pg_isready -U dev >/dev/null 2>&1 && break; sleep 1; done

echo "[harness] schema push + client generate..."
( cd "$CLOUD" && DATABASE_URL="$DBURL" npx prisma db push >/dev/null 2>&1 && DATABASE_URL="$DBURL" npx prisma generate >/dev/null 2>&1 ) || { echo "  prisma failed"; exit 1; }

echo "[harness] seed project/subsystem/IOs..."
docker exec $PG psql -U dev -d commissioning -q -v ON_ERROR_STOP=1 -c "
INSERT INTO projects (id,name,api_key,archived) VALUES (1,'DevTest','devkey123',false) ON CONFLICT (id) DO NOTHING;
INSERT INTO subsystems (id,project_id,name) VALUES (38,1,'MCM02 Dev') ON CONFLICT (id) DO NOTHING;
INSERT INTO ios (id,subsystemid,name,description,version) VALUES (9001,38,'IO_SEED_1','seed one',0),(9002,38,'IO_SEED_2','seed two',0) ON CONFLICT (id) DO NOTHING;" >/dev/null

echo "[harness] cloud dev on $CLOUD_PORT (DEV_BYPASS_AUTH)..."
( cd "$CLOUD" && DATABASE_URL="$DBURL" NODE_ENV=development DEV_BYPASS_AUTH=true \
  NEXTAUTH_SECRET=devsecret NEXTAUTH_URL="http://localhost:$CLOUD_PORT" \
  AZURE_AD_CLIENT_ID=dummy AZURE_AD_CLIENT_SECRET=dummy AZURE_AD_TENANT_ID=dummy \
  nohup npx next dev -p $CLOUD_PORT > "$RUN/cloud.log" 2>&1 & disown )
echo "[harness] waiting for cloud..."
CLOUD_OK=0
for i in $(seq 1 60); do
  curl -s -m 3 -H "X-API-Key: devkey123" "http://localhost:$CLOUD_PORT/api/sync/subsystem/38/changes?since=0" 2>/dev/null | grep -q '"success"' && { CLOUD_OK=1; echo "  cloud ready (${i}x2s)"; break; }
  sleep 2
done
[ $CLOUD_OK = 1 ] || { echo "  CLOUD FAILED — see $RUN/cloud.log"; tail -5 "$RUN/cloud.log"; exit 1; }

echo "[harness] field config + server on $FIELD_PORT (CLOUD_URL_OVERRIDE)..."
printf '{ "ApiPassword": "devkey123", "subsystemId": "38" }\n' > "$RUN/config.json"
( cd "$FE" && PORT=$FIELD_PORT PLC_WS_PORT=$FIELD_WS \
  CLOUD_URL_OVERRIDE="http://localhost:$CLOUD_PORT" \
  DATABASE_URL="file:$WRUN/field.db" CONFIG_PATH="$WRUN/config.json" \
  nohup npx tsx server-express.ts > "$RUN/field.log" 2>&1 & disown )

echo "[harness] waiting for field initial pull (>=2 seed IOs)..."
FIELD_OK=0
for i in $(seq 1 60); do
  C=$( cd "$FE" && node -e "try{const D=require('better-sqlite3');const db=new D(process.argv[1],{readonly:true,fileMustExist:true});process.stdout.write(String(db.prepare('SELECT COUNT(*) c FROM Ios').get().c))}catch(e){process.stdout.write('0')}" "$WRUN/field.db" 2>/dev/null )
  [ "${C:-0}" -ge 2 ] 2>/dev/null && { FIELD_OK=1; echo "  field pulled $C IOs (${i}x2s)"; break; }
  sleep 2
done
[ $FIELD_OK = 1 ] || { echo "  FIELD FAILED — see $RUN/field.log"; tail -8 "$RUN/field.log"; exit 1; }

echo "[harness] UP  cloud=$CLOUD_PORT field=$FIELD_PORT pg=$PGPORT  logs=$RUN/{cloud,field}.log"
