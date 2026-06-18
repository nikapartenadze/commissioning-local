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

# SEED_DB may be a bare filename or a path; only the basename is honored and
# it is always resolved inside /seed/. (A Git-Bash host mangles leading-slash
# env values into C:/Program Files/Git/... — basename defuses that too.)
SEED_DB = os.path.join("/seed", os.path.basename(os.environ.get("SEED_DB", "database.db").replace("\\", "/")))
DATA_DB = "/data/database.db"
CONFIG = "/data/config.json"
TAGS_OUT = "/gen/tags.txt"
CLOUD_SQL_OUT = "/gen/cloud_seed.sql"

# Per-project API key the tool authenticates sync with (X-API-Key). Must match
# the tool's config apiPassword (API_PASSWORD env). Battle-only value.
CLOUD_API_KEY = os.environ.get("API_PASSWORD", "***REMOVED***")

GATEWAY_IP = os.environ.get("GATEWAY_IP", "172.28.0.10")
PLC_PATH = os.environ.get("PLC_PATH", "1,0")
SUBSYSTEM_ID = os.environ.get("SUBSYSTEM_ID", "38")
KEEP_DATA = os.environ.get("KEEP_DATA") == "1"

# ── Multi-MCM (central-server scenario) ─────────────────────────────
# Two ways to get N MCMs:
#
# MCM_MODE=real — the seed DB already holds N REAL subsystems (e.g. the CDW5
# production dump, battle/seed/database-cdw5.db: 19 MCMs / 25k IOs). Every
# subsystem WITH IOs becomes a registry MCM; sim i serves subsystem i (sorted
# by id) at MCM_GATEWAY_IPS[i]; per-MCM tag files tags-<sid>.txt are emitted so
# each sim serves ONLY its own controller's tags (a wrong-PLC read/write fails
# loudly instead of silently succeeding).
#
# MCM_COUNT>1 (clone mode) — clones the base subsystem (SUBSYSTEM_ID) into N-1
# additional subsystems so the CENTRAL tool holds N concurrent registry PLC
# connections.
# Clone k (k=2..N):
#   subsystem id = base + (k-1)*1000        (38 → 1038, 2038, 3038…)
#   io id        = io.id + (k-1)*10_000_000 (unique, far above field ids)
#   PLC          = MCM_GATEWAY_IPS[k-1]     (one plc-sim container per MCM;
#                  every sim serves the SAME tag set, so /gen/tags.txt is shared)
# config.json gets an `mcms` array (registry connections) and, in multi mode,
# an EMPTY legacy ip so the singleton boot-autoconnect stays out of the way —
# everything runs through the mcm-registry, which is exactly what we're testing.
MCM_MODE = os.environ.get("MCM_MODE", "clone")  # clone | real
MCM_COUNT = int(os.environ.get("MCM_COUNT", "1"))
# Empty / unset → the sim addresses (.10 + one per additional sim, matching
# the generated compose override). A non-empty list (central-cdw5-live) points
# each MCM at a real Logix Emulate controller on the lab LAN.
_default_ips = ",".join(f"172.28.0.{10 + i}" for i in range(24))
MCM_GATEWAY_IPS = [
    ip.strip() for ip in (os.environ.get("MCM_GATEWAY_IPS", "").strip() or _default_ips).split(",") if ip.strip()
]
SUBSYSTEM_STRIDE = 1000
IO_ID_STRIDE = 10_000_000


# MCM_ONLY: comma-separated subsystem ids to KEEP (in this exact order), used
# when only a subset of MCMs is available on real hardware. When set, the
# kept subsystems align positionally with MCM_GATEWAY_IPS so each maps to its
# real controller. Empty/unset → all subsystems with IOs, id-sorted.
MCM_ONLY = [s.strip() for s in os.environ.get("MCM_ONLY", "").split(",") if s.strip()]


def real_subsystems(db: sqlite3.Connection) -> list[tuple[str, str]]:
    """MCM_MODE=real: subsystems with IOs. MCM_ONLY (if set) restricts to those
    ids IN THE GIVEN ORDER (positional match with MCM_GATEWAY_IPS); otherwise
    every subsystem with IOs, id-sorted. [(subsystemId, name), …]."""
    rows = db.execute(
        """SELECT s.id, s.Name FROM Subsystems s
           WHERE EXISTS (SELECT 1 FROM Ios i WHERE i.SubsystemId = s.id)
           ORDER BY s.id"""
    ).fetchall()
    by_id = {str(sid): (name or f"Subsystem {sid}") for sid, name in rows}
    if MCM_ONLY:
        return [(sid, by_id[sid]) for sid in MCM_ONLY if sid in by_id]
    return [(sid, name) for sid, name in ((str(s), n) for s, n in rows)]


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

    # The raw seed DB predates the L2Devices.SubsystemId column (added by the
    # tool's runtime migration, which runs AFTER this seeder). Add it here so the
    # per-MCM L2 clone below works; the tool's idempotent ALTER is a no-op later.
    try:
        cur.execute("ALTER TABLE L2Devices ADD COLUMN SubsystemId INTEGER")
    except sqlite3.OperationalError:
        pass  # column already present

    # Stamp the base subsystem's L2 devices (legacy rows are NULL-scoped). A NULL
    # SubsystemId matches EVERY subsystem via the tool's OR-NULL read fallback,
    # which would leak the base's FV devices into every cloned MCM's FV page
    # (the 2026-06-18 "FV shows one MCM" class). After this, each device is
    # scoped to exactly one MCM, so the clones below are genuinely distinct.
    cur.execute("UPDATE L2Devices SET SubsystemId = :base WHERE SubsystemId IS NULL", {"base": base})

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

        # L2 functional-validation: sheets/columns are the shared project
        # template (NOT cloned — they're global). DEVICES + their cell values are
        # per-MCM, so clone them with THIS subsystem's id/name and offset
        # ids/CloudIds. Each cloned MCM then has its OWN distinct FV devices —
        # the FV page per MCM, with zero cross-MCM sharing (proves the per-MCM
        # L2 fix end-to-end in the rig).
        cur.execute(
            'INSERT OR IGNORE INTO L2Devices '
            '(id, CloudId, SubsystemId, SheetId, DeviceName, Mcm, Subsystem, DisplayOrder, CompletedChecks, TotalChecks) '
            'SELECT id + :off, CASE WHEN CloudId IS NULL THEN NULL ELSE CloudId + :off END, :sid, SheetId, '
            'DeviceName, :name, :name, DisplayOrder, CompletedChecks, TotalChecks '
            'FROM L2Devices WHERE SubsystemId = :base',
            {"off": off, "sid": sid, "name": name, "base": base},
        )
        cur.execute(
            'INSERT OR IGNORE INTO L2CellValues '
            '(id, CloudCellId, DeviceId, ColumnId, Value, UpdatedBy, UpdatedAt, Version) '
            'SELECT cv.id + :off, CASE WHEN cv.CloudCellId IS NULL THEN NULL ELSE cv.CloudCellId + :off END, '
            'cv.DeviceId + :off, cv.ColumnId, cv.Value, cv.UpdatedBy, cv.UpdatedAt, cv.Version '
            'FROM L2CellValues cv JOIN L2Devices d ON d.id = cv.DeviceId WHERE d.SubsystemId = :base',
            {"off": off, "base": base},
        )
        ld = cur.execute("SELECT COUNT(*) FROM L2Devices WHERE SubsystemId = ?", (sid,)).fetchone()[0]

        # Network topology (rings → nodes → ports): per-MCM, so clone the FK
        # chain with offset ids. McmName is set to this MCM's name so the
        # diagnostics/network page shows THIS MCM's own ring (not the base's).
        cur.execute(
            'INSERT OR IGNORE INTO NetworkRings (id, SubsystemId, Name, McmName, McmIp, McmTag) '
            'SELECT id + :off, :sid, Name, :name, McmIp, McmTag FROM NetworkRings WHERE SubsystemId = :base',
            {"off": off, "sid": sid, "name": name, "base": base},
        )
        cur.execute(
            'INSERT OR IGNORE INTO NetworkNodes '
            '(id, RingId, Name, Position, IpAddress, CableIn, CableOut, StatusTag, TotalPorts) '
            'SELECT id + :off, RingId + :off, Name, Position, IpAddress, CableIn, CableOut, StatusTag, TotalPorts '
            'FROM NetworkNodes WHERE RingId IN (SELECT id FROM NetworkRings WHERE SubsystemId = :base)',
            {"off": off, "base": base},
        )
        cur.execute(
            'INSERT OR IGNORE INTO NetworkPorts '
            '(id, NodeId, PortNumber, CableLabel, DeviceName, DeviceType, DeviceIp, StatusTag, ParentPortId) '
            'SELECT id + :off, NodeId + :off, PortNumber, CableLabel, DeviceName, DeviceType, DeviceIp, StatusTag, '
            'CASE WHEN ParentPortId IS NULL THEN NULL ELSE ParentPortId + :off END '
            'FROM NetworkPorts WHERE NodeId IN '
            '(SELECT id FROM NetworkNodes WHERE RingId IN (SELECT id FROM NetworkRings WHERE SubsystemId = :base))',
            {"off": off, "base": base},
        )
        nr = cur.execute("SELECT COUNT(*) FROM NetworkRings WHERE SubsystemId = ?", (sid,)).fetchone()[0]
        print(f"seeder: cloned subsystem {base} -> {sid} ({name}): {n} IOs, {ld} L2 devices, {nr} network ring(s)")
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

    # ── 1b. multi-MCM (central-server scenario) ────────────────────
    rw = sqlite3.connect(DATA_DB)
    if MCM_MODE == "real":
        mcms = real_subsystems(rw)
        print(f"seeder: MCM_MODE=real — {len(mcms)} subsystems with IOs in the seed")
    else:
        mcms = clone_subsystems(rw)
    rw.close()
    multi = MCM_MODE == "real" or MCM_COUNT > 1

    # ── 2. config.json ─────────────────────────────────────────────
    config = {
        # Multi-MCM: EMPTY legacy ip — the singleton boot-autoconnect must not
        # grab sim-1 with the whole (cross-subsystem) IO table; the registry
        # owns every connection. Single-MCM: legacy behavior unchanged.
        "ip": GATEWAY_IP if not multi else "",
        "path": PLC_PATH,
        # Phase 0: no cloud — sync paths log-and-skip ("no remote URL" is a
        # known, suppressed log line). Phase 1 points this at cloud-stage.
        "remoteUrl": os.environ.get("REMOTE_URL", ""),
        "apiPassword": os.environ.get("API_PASSWORD", ""),
        "subsystemId": SUBSYSTEM_ID if MCM_MODE != "real" else (mcms[0][0] if mcms else SUBSYSTEM_ID),
        "orderMode": "0",
    }
    if multi:
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
    print(f"seeder: wrote {CONFIG} (gateway={GATEWAY_IP}, subsystem={config['subsystemId']}, mcms={len(config.get('mcms', []))})")

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

    # ── 3c. ambient CIP-saturation delay (SIM_DELAY_MS) ────────────
    # Write /gen/delay so EVERY plc-sim boots with a per-request delay (a site
    # of sluggish controllers). The sim entrypoint reads this file at start, so
    # no restart is needed — all MCMs come up slow, layered under the storms.
    # A fresh run with no delay set must clear any stale file from a prior run.
    delay_path = os.path.join(os.path.dirname(TAGS_OUT), "delay")
    delay_ms = os.environ.get("SIM_DELAY_MS", "").strip()
    if delay_ms.isdigit() and int(delay_ms) > 0:
        with open(delay_path, "w") as f:
            f.write(delay_ms)
        print(f"seeder: wrote {delay_path}: CIP-saturation {delay_ms}ms (all sims boot slow)")
    elif os.path.exists(delay_path):
        os.remove(delay_path)
        print(f"seeder: cleared stale {delay_path} (no SIM_DELAY_MS this run)")

    # ── 3b. per-MCM tag files (MCM_MODE=real) ──────────────────────
    # Each sim serves ONLY its subsystem's tags: that controller's IO tags,
    # its devices' ConnectionFaulted bits, and the CMD validation flags of the
    # L2 devices whose Mcm matches the subsystem's name. A read or write
    # routed to the wrong PLC then FAILS (tag-not-found) instead of silently
    # succeeding against an identical clone — so cross-MCM routing bugs in
    # the tool show up as hard errors in the soak.
    if MCM_MODE == "real":
        name_to_sid = {name.upper(): sid for sid, name in mcms}
        for sid, sub_name in mcms:
            per: dict[str, str] = {}
            for (tag_name,) in cur.execute(
                "SELECT DISTINCT Name FROM Ios WHERE SubsystemId = ? AND Name IS NOT NULL AND Name <> ''",
                (int(sid),),
            ):
                tag_name = tag_name.strip()
                if tag_ok(tag_name):
                    per[tag_name] = "SINT[1]"
            for (dev,) in cur.execute(
                "SELECT DISTINCT NetworkDeviceName FROM Ios WHERE SubsystemId = ? "
                "AND NetworkDeviceName IS NOT NULL AND NetworkDeviceName <> ''",
                (int(sid),),
            ):
                fault = f"{dev.strip()}:I.ConnectionFaulted"
                if tag_ok(fault):
                    per.setdefault(fault, "SINT[1]")
            # VFD CMD flags for the L2 devices this MCM owns (L2Devices.Mcm).
            for (dev, mcm_name) in cur.execute(
                """SELECT DISTINCT d.DeviceName, d.Mcm FROM L2Devices d
                   JOIN L2Sheets s ON s.id = d.SheetId
                   WHERE UPPER(s.Name) LIKE '%VFD%' OR UPPER(s.Name) LIKE '%APF%'"""
            ):
                owner = name_to_sid.get((mcm_name or "").strip().upper())
                # unmatched ownership → serve on every sim (can't mis-route a
                # tag the tool can find everywhere)
                if owner is not None and owner != sid:
                    continue
                for field in VFD_CMD_FIELDS:
                    flag = f"CBT_{dev.strip()}.CTRL.CMD.{field}"
                    if tag_ok(flag):
                        per.setdefault(flag, "SINT[1]")
            out = os.path.join(os.path.dirname(TAGS_OUT), f"tags-{sid}.txt")
            with open(out, "w") as f:
                for tag_name, decl in sorted(per.items()):
                    f.write(f"--tag={tag_name}:{decl}\n")
            print(f"seeder: wrote {out}: {len(per)} tags ({sub_name})")

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
        "SELECT id, SubsystemId, Name, Description, \"Order\", COALESCE(Version, 0), Result, Comments FROM Ios "
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
    for (iid, sid, name, desc, order, ver, result, comments) in ios:
        order_sql = "NULL" if order is None else str(int(order))
        # Mirror the local result AND comments so pre-existing field state
        # matches cloud and only genuine soak-changes are tracked by I4 (F3
        # fix; comments asymmetry tripped the scoped pull-guard on every
        # auto-pull in the 2026-06-07 central-cdw5 round).
        lines.append(
            "INSERT INTO ios (id, subsystemid, name, description, \"Order\", version, result, comments) "
            f"VALUES ({int(iid)}, {int(sid)}, {sql_str(name)}, {sql_str(desc)}, {order_sql}, {int(ver)}, {sql_str(result)}, {sql_str(comments)}) "
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
