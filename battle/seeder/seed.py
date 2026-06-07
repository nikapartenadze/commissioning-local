#!/usr/bin/env python3
"""
One-shot seeder for the battle stack. Runs before tool and plc-sim:

  1. /seed/database.db  → /data/database.db   (fresh copy each run unless KEEP_DATA=1)
  2. writes /data/config.json                  (PLC gateway → plc-sim or the
                                                Emulate box, subsystem, no cloud)
  3. generates /gen/tags.txt                   (ab_server --tag args from the DB)

The seed DB is a checkpointed copy of a REAL field database (MCM02: 72
commissioned VFDs, 1184 IOs — the dataset that broke v2.40.0). See
tools/prepare_seed.py for how it's produced.

Env:
  GATEWAY_IP    PLC the tool should talk to. Default 172.28.0.10 (plc-sim).
                Point at 192.168.5.107 (or wherever the Emulate box lives
                today) for high-fidelity runs — plc-sim then sits idle.
  PLC_PATH      default "1,0"
  SUBSYSTEM_ID  default "38" (MCM02's subsystem in the seed DB)
  KEEP_DATA=1   don't overwrite an existing /data/database.db (resume a soak)
"""
import json
import os
import shutil
import sqlite3
import sys

SEED_DB = "/seed/database.db"
DATA_DB = "/data/database.db"
CONFIG = "/data/config.json"
TAGS_OUT = "/gen/tags.txt"
CLOUD_SQL_OUT = "/gen/cloud_seed.sql"

# Per-project API key the tool authenticates sync with (X-API-Key). Must match
# the tool's config apiPassword (API_PASSWORD env). Battle-only value.
CLOUD_API_KEY = os.environ.get("API_PASSWORD", "battle-key-mcm02")

GATEWAY_IP = os.environ.get("GATEWAY_IP", "172.28.0.10")
PLC_PATH = os.environ.get("PLC_PATH", "1,0")
SUBSYSTEM_ID = os.environ.get("SUBSYSTEM_ID", "38")
KEEP_DATA = os.environ.get("KEEP_DATA") == "1"

# ── Multi-MCM (central-server scenario) ─────────────────────────────
# MCM_COUNT>1 clones the base subsystem (SUBSYSTEM_ID) into N-1 additional
# subsystems so the CENTRAL tool holds N concurrent registry PLC connections.
# Clone k (k=2..N):
#   subsystem id = base + (k-1)*1000        (38 → 1038, 2038, 3038…)
#   io id        = io.id + (k-1)*10_000_000 (unique, far above field ids)
#   PLC          = MCM_GATEWAY_IPS[k-1]     (one plc-sim container per MCM;
#                  every sim serves the SAME tag set, so /gen/tags.txt is shared)
# config.json gets an `mcms` array (registry connections) and, in multi mode,
# an EMPTY legacy ip so the singleton boot-autoconnect stays out of the way —
# everything runs through the mcm-registry, which is exactly what we're testing.
MCM_COUNT = int(os.environ.get("MCM_COUNT", "1"))
MCM_GATEWAY_IPS = [
    ip.strip() for ip in os.environ.get(
        "MCM_GATEWAY_IPS",
        "172.28.0.10,172.28.0.11,172.28.0.12,172.28.0.13,172.28.0.14,172.28.0.15",
    ).split(",") if ip.strip()
]
SUBSYSTEM_STRIDE = 1000
IO_ID_STRIDE = 10_000_000


def clone_subsystems(db: sqlite3.Connection) -> list[tuple[str, str]]:
    """Clone the base subsystem MCM_COUNT-1 times. Returns the full MCM list
    [(subsystemId, name), …] including the base. Idempotent (INSERT OR IGNORE)."""
    base = int(SUBSYSTEM_ID)
    mcms = [(str(base), "MCM02")]
    if MCM_COUNT <= 1:
        return mcms

    cur = db.cursor()
    cols = [r[1] for r in cur.execute("PRAGMA table_info(Ios)").fetchall()]
    sel_cols = ", ".join(
        f'"{c}"' if c not in ("id", "SubsystemId") else
        ('id + :off AS id' if c == "id" else ":sid AS SubsystemId")
        for c in cols
    )
    col_list = ", ".join(f'"{c}"' for c in cols)

    for k in range(2, MCM_COUNT + 1):
        sid = base + (k - 1) * SUBSYSTEM_STRIDE
        off = (k - 1) * IO_ID_STRIDE
        name = f"MCM02-{k}"
        cur.execute(
            "INSERT OR IGNORE INTO Subsystems (id, ProjectId, Name) "
            "SELECT :sid, ProjectId, :name FROM Subsystems WHERE id = :base",
            {"sid": sid, "name": name, "base": base},
        )
        cur.execute(
            f'INSERT OR IGNORE INTO Ios ({col_list}) '
            f'SELECT {sel_cols} FROM Ios WHERE SubsystemId = :base',
            {"off": off, "sid": sid, "base": base},
        )
        n = cur.execute("SELECT COUNT(*) FROM Ios WHERE SubsystemId = ?", (sid,)).fetchone()[0]
        print(f"seeder: cloned subsystem {base} -> {sid} ({name}): {n} IOs")
        mcms.append((str(sid), name))
    db.commit()
    return mcms

VFD_CMD_FIELDS = ["Valid_Map", "Valid_HP", "Valid_Direction", "Normal_Polarity", "Reverse_Polarity"]

# ab_server tag-name charset after our patch: anything goes except whitespace
# and the structural characters of the definition syntax itself.
FORBIDDEN = set(" \t\"'[]")


def tag_ok(name: str) -> bool:
    return bool(name) and not (set(name) & FORBIDDEN)


def main() -> None:
    # ── 1. database ────────────────────────────────────────────────
    if os.path.exists(DATA_DB) and KEEP_DATA:
        print(f"seeder: KEEP_DATA=1, leaving existing {DATA_DB}")
    else:
        # Remove stale WAL/SHM so the tool opens a clean checkpointed copy.
        for suffix in ("", "-wal", "-shm"):
            p = DATA_DB + suffix
            if os.path.exists(p):
                os.remove(p)
        shutil.copyfile(SEED_DB, DATA_DB)
        print(f"seeder: seeded {DATA_DB} from {SEED_DB} ({os.path.getsize(DATA_DB)} bytes)")

    # ── 1b. multi-MCM cloning (central-server scenario) ────────────
    rw = sqlite3.connect(DATA_DB)
    mcms = clone_subsystems(rw)
    rw.close()

    # ── 2. config.json ─────────────────────────────────────────────
    config = {
        # Multi-MCM: EMPTY legacy ip — the singleton boot-autoconnect must not
        # grab sim-1 with the whole (cross-subsystem) IO table; the registry
        # owns every connection. Single-MCM: legacy behavior unchanged.
        "ip": GATEWAY_IP if MCM_COUNT <= 1 else "",
        "path": PLC_PATH,
        # Phase 0: no cloud — sync paths log-and-skip ("no remote URL" is a
        # known, suppressed log line). Phase 1 points this at cloud-stage.
        "remoteUrl": os.environ.get("REMOTE_URL", ""),
        "apiPassword": os.environ.get("API_PASSWORD", ""),
        "subsystemId": SUBSYSTEM_ID,
        "orderMode": "0",
    }
    if MCM_COUNT > 1:
        config["mcms"] = [
            {
                "subsystemId": sid,
                "name": name,
                "ip": MCM_GATEWAY_IPS[i] if i < len(MCM_GATEWAY_IPS) else "",
                "path": PLC_PATH,
                "enabled": True,
            }
            for i, (sid, name) in enumerate(mcms)
        ]
    with open(CONFIG, "w") as f:
        json.dump(config, f, indent=2)
    print(f"seeder: wrote {CONFIG} (gateway={GATEWAY_IP}, subsystem={SUBSYSTEM_ID}, mcms={len(config.get('mcms', []))})")

    # ── 3. tag set for plc-sim ─────────────────────────────────────
    db = sqlite3.connect(f"file:{DATA_DB}?mode=ro", uri=True)
    cur = db.cursor()
    tags: dict[str, str] = {}  # name -> type decl
    skipped: list[str] = []

    # IO tags — exactly what the tag reader will create.
    for (name,) in cur.execute("SELECT DISTINCT Name FROM Ios WHERE Name IS NOT NULL AND Name <> ''"):
        name = name.strip()
        if tag_ok(name):
            tags[name] = "SINT[1]"
        else:
            skipped.append(name)

    # ConnectionFaulted bits — read by the network-status path and the VFD
    # writer's faulted-device guard.
    for (dev,) in cur.execute(
        "SELECT DISTINCT NetworkDeviceName FROM Ios WHERE NetworkDeviceName IS NOT NULL AND NetworkDeviceName <> ''"
    ):
        name = f"{dev.strip()}:I.ConnectionFaulted"
        if tag_ok(name):
            tags.setdefault(name, "SINT[1]")

    # VFD validation/polarity CMD flags — the v2.40.1 writer's targets.
    vfd_rows = cur.execute(
        """SELECT DISTINCT d.DeviceName FROM L2Devices d JOIN L2Sheets s ON s.id = d.SheetId
           WHERE UPPER(s.Name) LIKE '%VFD%' OR UPPER(s.Name) LIKE '%APF%'"""
    ).fetchall()
    for (dev,) in vfd_rows:
        for field in VFD_CMD_FIELDS:
            name = f"CBT_{dev.strip()}.CTRL.CMD.{field}"
            if tag_ok(name):
                tags.setdefault(name, "SINT[1]")

    os.makedirs(os.path.dirname(TAGS_OUT), exist_ok=True)
    with open(TAGS_OUT, "w") as f:
        for name, decl in sorted(tags.items()):
            f.write(f"--tag={name}:{decl}\n")

    print(f"seeder: wrote {TAGS_OUT}: {len(tags)} tags "
          f"({len(vfd_rows)} VFD devices x {len(VFD_CMD_FIELDS)} CMD flags), {len(skipped)} skipped")
    if skipped:
        print("seeder: skipped (bad chars): " + ", ".join(repr(s) for s in skipped[:10]))

    if len(tags) < 100:
        sys.exit("seeder: suspiciously few tags — wrong seed DB?")

    # ── 4. cloud-stage seed SQL ────────────────────────────────────
    # The throwaway cloud Postgres must hold the SAME IOs (matching ids) under
    # a project whose api_key == the tool's apiPassword, so the tool's pushes
    # (validated cloud-side by io->subsystem->project.apiKey) are accepted and
    # the I4 data-loss invariant can read results back. Cloud-stage MIRRORS the
    # local DB's initial RESULTS too: the field seed has ~500 pre-existing MCM02
    # results, and the tool only syncs CHANGES — so a bot re-marking an already-
    # set value is a no-op (resultChanged=false, no PendingSync). If cloud
    # started NULL, those pre-existing results would look "unsynced" forever and
    # FALSELY trip I4 (caught in the 2026-06-06 overnight soak — F3). Mirroring
    # the initial state means I4 only flags genuine soak-changes.
    gen_cloud_seed(cur, {int(sid): name for sid, name in mcms})


def sql_str(v) -> str:
    if v is None:
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


def gen_cloud_seed(cur, names: dict[int, str] | None = None) -> None:
    subs = [r[0] for r in cur.execute("SELECT DISTINCT SubsystemId FROM Ios WHERE SubsystemId IS NOT NULL")]
    # version MUST mirror local: the tool pushes the BASE version it pulled and
    # cloud's `updateMany WHERE version = base` only matches if cloud holds that
    # same base. Seeding cloud at 0 while local is at 6 makes every push a
    # permanent version conflict (discovered in battle, 2026-06-06). In the
    # field this is aligned because local pulled its versions FROM cloud.
    ios = cur.execute(
        "SELECT id, SubsystemId, Name, Description, \"Order\", COALESCE(Version, 0), Result FROM Ios "
        "WHERE Name IS NOT NULL AND Name <> ''"
    ).fetchall()

    lines = [
        "-- Battle cloud-stage seed (generated). Throwaway DB — never prod.",
        "BEGIN;",
        "INSERT INTO projects (id, name, api_key, archived) "
        f"VALUES (1, 'BATTLE MCM02', {sql_str(CLOUD_API_KEY)}, false) "
        "ON CONFLICT (id) DO UPDATE SET api_key = EXCLUDED.api_key;",
    ]
    for sid in subs:
        sub_name = (names or {}).get(int(sid), "MCM02")
        lines.append(
            f"INSERT INTO subsystems (id, project_id, name) "
            f"VALUES ({sid}, 1, {sql_str(sub_name)}) ON CONFLICT (id) DO NOTHING;"
        )
    for (iid, sid, name, desc, order, ver, result) in ios:
        order_sql = "NULL" if order is None else str(int(order))
        # Mirror the local result so pre-existing field results match cloud and
        # only genuine soak-changes are tracked by I4 (F3 fix).
        lines.append(
            "INSERT INTO ios (id, subsystemid, name, description, \"Order\", version, result) "
            f"VALUES ({int(iid)}, {int(sid)}, {sql_str(name)}, {sql_str(desc)}, {order_sql}, {int(ver)}, {sql_str(result)}) "
            "ON CONFLICT (id) DO NOTHING;"
        )
    # Keep the sequences ahead of our explicit ids so cloud-side inserts (the
    # mutation scenario adding NEW ios) don't collide.
    lines.append("SELECT setval(pg_get_serial_sequence('ios','id'), (SELECT MAX(id) FROM ios));")
    lines.append("SELECT setval(pg_get_serial_sequence('subsystems','id'), (SELECT MAX(id) FROM subsystems));")
    lines.append("SELECT setval(pg_get_serial_sequence('projects','id'), (SELECT MAX(id) FROM projects));")
    lines.append("COMMIT;")

    os.makedirs(os.path.dirname(CLOUD_SQL_OUT), exist_ok=True)
    with open(CLOUD_SQL_OUT, "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"seeder: wrote {CLOUD_SQL_OUT}: project 1 (api_key set), "
          f"{len(subs)} subsystem(s), {len(ios)} ios")


if __name__ == "__main__":
    main()
