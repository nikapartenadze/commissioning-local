"""
Batch-upload Logix controller programs via the Studio 5000 Logix Designer SDK.

For each controller communications path you give it, uploads the RUNNING program
into a NEW .acd file in the output directory (default: the current folder). No
pre-existing project is needed — uses LogixProject.upload_to_new_project, which
creates the .acd from the controller and leaves the controller Offline.

Normally launched by batch-upload.bat (which supplies the SDK venv python).
Direct:
    python batch_upload.py [--out DIR] [comm_path ...]
If no comm paths are passed, it reads controllers.txt (one path per line) from
the output dir, or prompts you for a ';'-separated list.

Requires Studio 5000 + the Logix Designer SDK (LdSdkServer.exe) on this machine.
"""
import sys
import os
import re
import asyncio
import argparse
from datetime import datetime

from logix_designer_sdk import LogixProject, OperationEvent


def safe(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_")
    return (s[:40] or "controller")


class Log(OperationEvent):
    def __init__(self, tag):
        self.tag = tag

    def set_progress(self, project_file, value):
        try:
            sys.stdout.write(f"\r    [{self.tag}] {int(value)}%   ")
            sys.stdout.flush()
        except Exception:
            pass

    def log_status_message(self, project_file, msg):
        print(f"\n    [{self.tag}] {msg}")

    def log_error_message(self, project_file, msg):
        print(f"\n    [{self.tag}] ERROR: {msg}")


async def upload_one(comm, outdir, idx):
    tag = safe(comm)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out = os.path.join(outdir, f"upload_{idx:02d}_{tag}_{stamp}.acd")
    print(f"\n[{idx}] Uploading from: {comm}")
    print(f"     -> {out}")
    try:
        proj = await LogixProject.upload_to_new_project(out, comm, Log(tag))
        try:
            proj.close()
        except Exception:
            pass
        print(f"\n[{idx}] OK")
        return (comm, True, out)
    except Exception as e:
        print(f"\n[{idx}] FAILED: {type(e).__name__}: {e}")
        return (comm, False, f"{type(e).__name__}: {e}")


def gather_paths(args, outdir):
    if args.comm:
        return args.comm
    txt = os.path.join(outdir, "controllers.txt")
    if os.path.isfile(txt):
        with open(txt, encoding="utf-8") as f:
            paths = [ln.strip() for ln in f if ln.strip() and not ln.lstrip().startswith("#")]
        if paths:
            print(f"Read {len(paths)} comm path(s) from {txt}")
            return paths
    print("Enter controller comm path(s), separated by ';'")
    print("  e.g.  AB_ETHIP-1\\192.168.1.10\\Backplane\\0  ;  AB_ETHIP-1\\192.168.1.11\\Backplane\\0")
    raw = input("> ").strip()
    return [p.strip() for p in raw.split(";") if p.strip()]


async def main():
    ap = argparse.ArgumentParser(description="Batch-upload Logix controllers to .acd files.")
    ap.add_argument("--out", default=os.getcwd(), help="output directory (default: current dir)")
    ap.add_argument("comm", nargs="*", help="controller comm path(s)")
    args = ap.parse_args()

    outdir = os.path.abspath(args.out)
    os.makedirs(outdir, exist_ok=True)

    paths = gather_paths(args, outdir)
    if not paths:
        print("No comm paths given. Nothing to do.")
        return 1

    print(f"\nUploading {len(paths)} controller(s) into:\n  {outdir}")
    print("=" * 64)
    results = []
    for i, comm in enumerate(paths, 1):
        results.append(await upload_one(comm, outdir, i))

    print("\n" + "=" * 64)
    print("SUMMARY")
    ok = [r for r in results if r[1]]
    bad = [r for r in results if not r[1]]
    for comm, good, info in results:
        print(f"  {'OK  ' if good else 'FAIL'}  {comm}" + ("" if good else f"   ({info})"))
    print(f"\n{len(ok)} uploaded, {len(bad)} failed.  Files in: {outdir}")
    return 0 if not bad else 2


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(130)
