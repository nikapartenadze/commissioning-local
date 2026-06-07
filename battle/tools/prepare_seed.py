#!/usr/bin/env python3
"""
Produce battle/seed/database.db from a field database copy.

Usage:  python battle/tools/prepare_seed.py mcm02/database.db

Copies the DB (with its -wal/-shm siblings if present), opens the COPY, and
checkpoints the WAL into the main file so the seed is a single self-contained
.db. Never opens the source read-write — a field DB copy is evidence; treat
it as read-only.
"""
import os
import shutil
import sqlite3
import sys

if len(sys.argv) != 2:
    sys.exit("usage: prepare_seed.py <path/to/database.db>")

src = sys.argv[1]
dst_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "seed")
os.makedirs(dst_dir, exist_ok=True)
dst = os.path.join(dst_dir, "database.db")

# copy db + wal + shm so the checkpoint sees the full picture
for suffix in ("", "-wal", "-shm"):
    s, d = src + suffix, dst + suffix
    if os.path.exists(s):
        shutil.copyfile(s, d)
        print(f"copied {s} -> {d} ({os.path.getsize(d)} bytes)")

db = sqlite3.connect(dst)
db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
db.execute("PRAGMA journal_mode=DELETE")  # single-file seed
db.commit()
ios, vfds = db.execute(
    """SELECT (SELECT COUNT(*) FROM Ios),
              (SELECT COUNT(DISTINCT d.DeviceName) FROM L2Devices d
               JOIN L2Sheets s ON s.id=d.SheetId
               WHERE UPPER(s.Name) LIKE '%VFD%' OR UPPER(s.Name) LIKE '%APF%')"""
).fetchone()
ok = db.execute("PRAGMA integrity_check").fetchone()[0]
db.close()

for suffix in ("-wal", "-shm"):
    p = dst + suffix
    if os.path.exists(p):
        os.remove(p)

print(f"seed ready: {dst} — integrity={ok}, IOs={ios}, VFD devices={vfds}")
if ok != "ok":
    sys.exit("integrity check FAILED")
