#!/usr/bin/env python3
"""
Build the CDW5 multi-MCM battle seed from a READ-ONLY dump of the production
cloud DB. Run on a dev box with `ssh dockerhost` access:

    python battle/tools/prepare_cdw5_seed.py

Reads (SELECT only, via psql COPY csv over ssh):
    subsystems        project 15 (CDW5) — 19 MCMs
    ios               those subsystems (~25k IOs, results+versions mirrored)
    l2_sheets/columns/devices/cell_values   template(s) of project 15

Writes battle/seed/database-cdw5.db — a local-tool-format SQLite built on the
schema of the existing MCM02 seed (battle/seed/database.db), with operational
tables (queues, histories, estop/safety/network) emptied.

NOTHING here writes to production: every query is a COPY (SELECT …) TO STDOUT.
"""
import csv
import io
import re
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent  # battle/
BASE_SEED = HERE / "seed" / "database.db"
OUT_DB = HERE / "seed" / "database-cdw5.db"
PROJECT_ID = 15
PSQL = 'docker exec commissioning-db psql -U Sharpness6069 -d autstand'


def dump(query: str) -> list[dict]:
    """COPY (query) TO STDOUT WITH (FORMAT csv, HEADER) over ssh, parsed."""
    sql = f"COPY ({query}) TO STDOUT WITH (FORMAT csv, HEADER)"
    # Two shell layers (local ssh arg + remote sh): escape the embedded double
    # quotes (e.g. the "Order" identifier) so they survive to psql.
    cmd = ["ssh", "dockerhost", f'{PSQL} -c "{sql.replace(chr(34), chr(92) + chr(34))}"']
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        sys.exit(f"dump failed: {r.stderr[:500]}")
    return list(csv.DictReader(io.StringIO(r.stdout)))


def b(v: str | None) -> int:
    return 1 if v == "t" else 0


def n(v: str | None):
    return None if v in (None, "") else v


def extract_device_name(tag: str | None) -> str | None:
    """Port of frontend/lib/db-sqlite.ts extractDeviceName()."""
    if not tag:
        return None
    if ":" in tag and tag.index(":") > 0:
        return tag.split(":", 1)[0]
    m = re.match(r"^(.+?)_X\d", tag)
    if m:
        return m.group(1)
    if "." in tag and tag.index(".") > 0:
        return tag.split(".", 1)[0]
    return None


def main() -> None:
    if not BASE_SEED.exists():
        sys.exit(f"base seed missing: {BASE_SEED} (schema template)")

    print("dumping production (read-only)…")
    subs = dump(f"SELECT id, name FROM subsystems WHERE project_id = {PROJECT_ID} ORDER BY id")
    sids = ",".join(s["id"] for s in subs)
    ios = dump(
        'SELECT id, subsystemid, name, description, "Order" AS ord, version, result, '
        f"comments, trade, clarification_note, punchlist_status, timestamp FROM ios WHERE subsystemid IN ({sids})"
    )
    sheets = dump(
        "SELECT s.id, s.name, s.display_name, s.display_order, s.discipline, s.device_count "
        f"FROM l2_sheets s JOIN l2_templates t ON t.id = s.template_id WHERE t.project_id = {PROJECT_ID}"
    )
    sheet_ids = ",".join(s["id"] for s in sheets) or "0"
    cols = dump(
        "SELECT id, sheet_id, name, column_type, input_type, display_order, is_system, "
        "is_editable, include_in_progress, is_required, description "
        f"FROM l2_columns WHERE sheet_id IN ({sheet_ids})"
    )
    devs = dump(
        "SELECT id, sheet_id, device_name, mcm, subsystem, display_order, completed_checks, total_checks "
        f"FROM l2_devices WHERE sheet_id IN ({sheet_ids})"
    )
    dev_ids_sub = f"SELECT id FROM l2_devices WHERE sheet_id IN ({sheet_ids})"
    cells = dump(
        "SELECT id, device_id, column_id, value, updated_by, updated_at, version "
        f"FROM l2_cell_values WHERE device_id IN ({dev_ids_sub})"
    )
    print(f"  {len(subs)} subsystems, {len(ios)} ios, {len(sheets)} sheets, "
          f"{len(cols)} columns, {len(devs)} devices, {len(cells)} cells")

    print(f"building {OUT_DB.name} on the MCM02 seed's schema…")
    shutil.copyfile(BASE_SEED, OUT_DB)
    con = sqlite3.connect(OUT_DB)
    cur = con.cursor()

    # Wipe every data table we re-seed or that must start empty.
    for tbl in (
        "Ios", "Subsystems", "Projects", "TestHistories", "PendingSyncs",
        "L2PendingSyncs", "L2Sheets", "L2Columns", "L2Devices", "L2CellValues",
        "EStopIoPoints", "EStopVfds", "EStopEpcs", "EStopZones",
        "SafetyZoneDrives", "SafetyZones", "SafetyOutputs",
        "NetworkPorts", "NetworkNodes", "NetworkRings",
        "PunchlistItems", "Punchlists", "VfdControlsVerified",
        "DeviceBlockerPendingSyncs",
    ):
        try:
            cur.execute(f"DELETE FROM {tbl}")
        except sqlite3.Error:
            pass  # table may not exist in this schema build

    cur.execute("INSERT INTO Projects (id, Name) VALUES (1, 'CDW5')")
    for s in subs:
        cur.execute("INSERT INTO Subsystems (id, ProjectId, Name) VALUES (?, 1, ?)", (s["id"], s["name"]))

    for io_ in ios:
        cur.execute(
            """INSERT INTO Ios (id, Name, Description, SubsystemId, Result, Comments, Timestamp,
                                IoNumber, Version, Trade, ClarificationNote, NetworkDeviceName,
                                PunchlistStatus, CloudSyncedAt, "Order")
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)""",
            (
                io_["id"], io_["name"], n(io_["description"]), io_["subsystemid"],
                n(io_["result"]), n(io_["comments"]), n(io_["timestamp"]),
                n(io_["ord"]), int(io_["version"] or 0), n(io_["trade"]),
                n(io_["clarification_note"]), extract_device_name(io_["name"]),
                n(io_["punchlist_status"]), n(io_["ord"]),
            ),
        )

    for s in sheets:
        cur.execute(
            "INSERT INTO L2Sheets (id, CloudId, Name, DisplayName, DisplayOrder, Discipline, DeviceCount) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (s["id"], s["id"], s["name"], n(s["display_name"]), int(s["display_order"] or 0),
             n(s["discipline"]), int(s["device_count"] or 0)),
        )
    for c in cols:
        cur.execute(
            "INSERT INTO L2Columns (id, CloudId, SheetId, Name, ColumnType, InputType, DisplayOrder, "
            "IsSystem, IsEditable, IncludeInProgress, IsRequired, Description) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (c["id"], c["id"], c["sheet_id"], c["name"], c["column_type"] or "text",
             n(c["input_type"]), int(c["display_order"] or 0), b(c["is_system"]),
             b(c["is_editable"]), b(c["include_in_progress"]), b(c["is_required"]), n(c["description"])),
        )
    for d in devs:
        cur.execute(
            "INSERT INTO L2Devices (id, CloudId, SheetId, DeviceName, Mcm, Subsystem, DisplayOrder, "
            "CompletedChecks, TotalChecks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (d["id"], d["id"], d["sheet_id"], d["device_name"], n(d["mcm"]), n(d["subsystem"]),
             int(d["display_order"] or 0), int(d["completed_checks"] or 0), int(d["total_checks"] or 0)),
        )
    for c in cells:
        cur.execute(
            "INSERT INTO L2CellValues (id, CloudCellId, DeviceId, ColumnId, Value, UpdatedBy, UpdatedAt, Version) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (c["id"], c["id"], c["device_id"], c["column_id"], n(c["value"]),
             n(c["updated_by"]), n(c["updated_at"]), int(c["version"] or 0)),
        )

    con.commit()
    cur.execute("VACUUM")
    con.close()
    print(f"done: {OUT_DB} ({OUT_DB.stat().st_size} bytes)")
    print("subsystems:", ", ".join(f"{s['id']}={s['name']}" for s in subs))


if __name__ == "__main__":
    main()
