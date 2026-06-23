"""
Logix Designer SDK bridge for the commissioning tool.

Runs as a PERSISTENT process: reads one JSON command object per line on stdin,
performs the requested Logix Designer SDK operation, and emits newline-delimited
JSON (NDJSON) events on stdout:

    {"type":"progress","percent":N}
    {"type":"status","msg":"..."}
    {"type":"error","msg":"..."}            # SDK-level error log line (non-fatal)
    {"type":"result","ok":true,...}         # always the final line for a command

Opened projects are cached for the lifetime of the process (keyed by .acd path),
so successive ops (status -> mode -> mode -> download) reuse the SAME online
session instead of re-opening + re-connecting (~20s) every call — the "warm
session". The process exits on EOF (stdin closed) or a {"op":"shutdown"} command,
closing any cached projects on the way out.

Backward-compatible with one-shot callers: a caller that writes a single command
and closes stdin gets the result, then the readline returns EOF and the process
exits normally.

Commands (op):
    health                                  -> SDK import / availability check
    comm_path  {acd}                        -> read stored communications path
    status     {acd, comm?}                 -> read controller mode (online)
    mode       {acd, comm?, mode}           -> change mode PROGRAM|RUN|TEST
    download   {acd, comm?}                 -> Program -> download -> Run -> save
    upload     {acd, comm?, out?}           -> upload running project into <out>
    upload_new {comm, out}                  -> upload running controller into a
                                               NEW .acd at <out> (no input project)
    shutdown                                -> close cached projects and exit

Requires the Rockwell Logix Designer SDK installed (LdSdkServer.exe) and a
licensed Studio 5000. Windows only.
"""
import sys
import json
import asyncio
import traceback


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


async def _run(cmd, cache):
    """Execute one command. `cache` maps acd path -> open LogixProject so that
    successive ops reuse the same warm/online session. Projects are NOT closed
    per-op; serve() closes them all on shutdown/EOF."""
    op = cmd.get("op")
    rid = cmd.get("id")

    if op == "health":
        # Import is enough to confirm the SDK + its .NET assemblies load.
        from logix_designer_sdk import LogixProject  # noqa: F401
        emit({"type": "result", "ok": True, "id": rid, "op": "health", "sdk": "logix_designer_sdk"})
        return

    from logix_designer_sdk import (
        LogixProject,
        RequestedControllerMode,
        OperationEvent,
    )

    mode_map = {
        "PROGRAM": RequestedControllerMode.PROGRAM,
        "RUN": RequestedControllerMode.RUN,
        "TEST": RequestedControllerMode.TEST,
    }

    class JsonEventLogger(OperationEvent):
        def set_progress(self, project_file, value):
            try:
                emit({"type": "progress", "percent": int(value)})
            except Exception:
                pass

        def log_status_message(self, project_file, msg):
            emit({"type": "status", "msg": str(msg)})

        def log_error_message(self, project_file, msg):
            emit({"type": "error", "msg": str(msg)})

    logger = JsonEventLogger()

    # upload_new creates a NEW .acd directly from the running controller — there
    # is no input project to open or cache, so it runs BEFORE the `acd` gate.
    if op == "upload_new":
        comm = cmd.get("comm") or None
        out = cmd.get("out") or None
        if not comm:
            emit({"type": "result", "ok": False, "id": rid, "error": "missing 'comm' communications path"})
            return
        if not out:
            emit({"type": "result", "ok": False, "id": rid, "error": "missing 'out' output .acd path"})
            return
        emit({"type": "status", "msg": f"Uploading running controller into new project {out}"})
        proj = await LogixProject.upload_to_new_project(out, comm, logger)
        try:
            proj.close()
        except Exception:
            pass
        emit({"type": "result", "ok": True, "id": rid, "op": "upload_new", "comm_path": comm, "out": out})
        return

    acd = cmd.get("acd")
    comm = cmd.get("comm") or None
    if not acd:
        emit({"type": "result", "ok": False, "id": rid, "error": "missing 'acd' project path"})
        return

    # Reuse the cached (already-open, already-online) project when present.
    project = cache.get(acd)
    if project is None:
        emit({"type": "status", "msg": f"Opening project {acd}"})
        project = await LogixProject.open_logix_project(acd, logger)
        cache[acd] = project
    else:
        emit({"type": "status", "msg": "Reusing open project (warm session)"})

    # Resolve communications path: explicit override or the one stored in the ACD.
    if op == "comm_path":
        stored = await project.get_communications_path()
        emit({"type": "result", "ok": True, "id": rid, "op": op, "comm_path": stored})
        return

    if not comm:
        comm = await project.get_communications_path()
    if comm:
        await project.set_communications_path(comm)

    def mode_name(m):
        return str(m).split(".")[-1]

    if op == "status":
        mode = await project.read_controller_mode()
        emit({"type": "result", "ok": True, "id": rid, "op": op, "comm_path": comm, "mode": mode_name(mode)})

    elif op == "mode":
        target = mode_map.get(str(cmd.get("mode", "")).upper())
        if target is None:
            emit({"type": "result", "ok": False, "id": rid, "error": f"invalid mode '{cmd.get('mode')}' (use PROGRAM|RUN|TEST)"})
            return
        await project.change_controller_mode(target)
        mode = await project.read_controller_mode()
        emit({"type": "result", "ok": True, "id": rid, "op": op, "comm_path": comm, "mode": mode_name(mode)})

    elif op == "download":
        emit({"type": "status", "msg": "Switching controller to PROGRAM"})
        await project.change_controller_mode(RequestedControllerMode.PROGRAM)
        emit({"type": "status", "msg": "Downloading project"})
        await project.download()
        emit({"type": "status", "msg": "Switching controller to RUN"})
        await project.change_controller_mode(RequestedControllerMode.RUN)
        await project.save()
        mode = await project.read_controller_mode()
        emit({"type": "result", "ok": True, "id": rid, "op": op, "comm_path": comm, "mode": mode_name(mode)})

    elif op == "upload":
        emit({"type": "status", "msg": "Uploading running project from controller"})
        await project.upload()
        await project.save()
        emit({"type": "result", "ok": True, "id": rid, "op": op, "comm_path": comm})

    else:
        emit({"type": "result", "ok": False, "id": rid, "error": f"unknown op '{op}'"})


async def serve():
    """Persistent command loop. One JSON command per line on stdin; opened
    projects cached across commands. Exits on EOF or {"op":"shutdown"}."""
    cache = {}
    loop = asyncio.get_running_loop()
    try:
        while True:
            # Block a worker thread on readline so we don't busy-spin the loop.
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if line == "":
                break  # EOF — stdin closed by the parent
            line = line.strip()
            if not line:
                continue
            try:
                cmd = json.loads(line)
            except Exception as e:
                emit({"type": "result", "ok": False, "error": f"bad request JSON: {e}"})
                continue
            if cmd.get("op") == "shutdown":
                break
            try:
                await _run(cmd, cache)
            except Exception as e:
                emit({"type": "result", "ok": False, "id": cmd.get("id"),
                      "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()})
                # Drop the (possibly broken) cached project so the next op on it
                # re-opens cleanly instead of reusing a wedged session.
                acd = cmd.get("acd")
                proj = cache.pop(acd, None) if acd else None
                if proj is not None:
                    try:
                        proj.close()
                    except Exception:
                        pass
    finally:
        for proj in list(cache.values()):
            try:
                proj.close()
            except Exception:
                pass


def main():
    try:
        asyncio.run(serve())
    except Exception as e:
        emit({"type": "result", "ok": False, "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()})
        sys.exit(1)


if __name__ == "__main__":
    main()
