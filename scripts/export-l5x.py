"""Batch ACD -> L5X export via the Studio 5000 Logix Designer SDK.

Feeds the cloud's approved-firmware L5X import (/admin/firmware "Import L5X")
without opening each project by hand: point this at ACD files or folders and it
writes a same-named .L5X next to each (or into --out).

Requirements (engineering workstation):
  - Studio 5000 Logix Designer installed (the SDK drives it headlessly)
  - Logix Designer SDK installed (ships with Studio 5000 v33+; wheel at
    C:/Users/Public/Documents/Studio 5000/Logix Designer SDK/python/)
  - Python 3.12/3.13 (NOT 3.14 — the SDK pins <3.14):
      py -3.13 -m pip install --user "<SDK dir>/python/logix_designer_sdk-2.0.2-py3-none-any.whl"

Usage:
  py -3.13 scripts/export-l5x.py <file.ACD | folder> [more...] [--out DIR] [--force]

Notes:
  - Studio 5000 autosave/backup copies (*.BAKnnn.acd, *_backup.ACD) are skipped
    when scanning folders (an explicit file argument is always exported).
  - Existing .L5X targets are skipped unless --force (or the ACD is newer).
  - Each export takes ~30-120s: the SDK boots a headless Logix Designer per
    project. Sequential on purpose — parallel opens fight over the service.
"""

import argparse
import asyncio
import re
import sys
import time
from pathlib import Path

from logix_designer_sdk.logix_project import LogixProject

BACKUP_RE = re.compile(r"(\.BAK\d+\.acd$)|(_backup\.acd$)", re.IGNORECASE)


def collect(paths: list[str]) -> list[Path]:
    acds: list[Path] = []
    for raw in paths:
        p = Path(raw)
        if p.is_dir():
            acds.extend(f for f in sorted(p.glob("*.[aA][cC][dD]")) if not BACKUP_RE.search(f.name))
        elif p.suffix.lower() == ".acd":
            acds.append(p)
        else:
            print(f"  ! skipping non-ACD argument: {p}")
    # De-dup while preserving order (folder + explicit file can overlap).
    seen: set[Path] = set()
    return [p for p in acds if not (p.resolve() in seen or seen.add(p.resolve()))]


async def export_one(acd: Path, l5x: Path) -> None:
    project = await LogixProject.open_logix_project(str(acd))
    try:
        # save_as converts by extension — .L5X target = full XML export,
        # equivalent to File > Save As > L5X in Studio 5000.
        await project.save_as(str(l5x), True)
    finally:
        project.close()  # sync in SDK 2.0.2


async def main() -> int:
    ap = argparse.ArgumentParser(description="Batch ACD -> L5X export (Logix Designer SDK)")
    ap.add_argument("paths", nargs="+", help="ACD files and/or folders to scan")
    ap.add_argument("--out", type=Path, default=None, help="write L5X files here (default: next to each ACD)")
    ap.add_argument("--force", action="store_true", help="re-export even when an up-to-date L5X exists")
    args = ap.parse_args()

    acds = collect(args.paths)
    if not acds:
        print("No ACD files found.")
        return 1
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)

    print(f"{len(acds)} project(s) to export\n")
    failures: list[str] = []
    for i, acd in enumerate(acds, 1):
        l5x = (args.out / acd.name if args.out else acd).with_suffix(".L5X")
        if not args.force and l5x.exists() and l5x.stat().st_mtime >= acd.stat().st_mtime:
            print(f"[{i}/{len(acds)}] {acd.name}: up-to-date L5X exists, skipping (--force to redo)")
            continue
        print(f"[{i}/{len(acds)}] {acd.name} -> {l5x.name} ...", flush=True)
        t0 = time.monotonic()
        try:
            await export_one(acd, l5x)
            print(f"    done in {time.monotonic() - t0:.0f}s ({l5x.stat().st_size // 1_000_000}MB)")
        except Exception as e:  # noqa: BLE001 — keep the batch going, report at the end
            failures.append(f"{acd.name}: {e}")
            print(f"    FAILED: {e}")

    if failures:
        print(f"\n{len(failures)} export(s) failed:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nAll exports complete. Import each L5X at /admin/firmware -> Import L5X.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
