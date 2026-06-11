"""
Logix Designer SDK bridge for the commissioning tool.

Reads a single JSON command object on stdin, performs the requested Logix
Designer SDK operation, and emits newline-delimited JSON (NDJSON) events on
stdout:

    {"type":"progress","percent":N}
    {"type":"status","msg":"..."}
    {"type":"error","msg":"..."}            # SDK-level error log line (non-fatal)
    {"type":"result","ok":true,...}         # always the final line

Commands (op):
    health                                  -> SDK import / availability check
    comm_path  {acd}                        -> read stored communications path
    status     {acd, comm?}                 -> read controller mode (online)
    mode       {acd, comm?, mode}           -> change mode PROGRAM|RUN|TEST
    download   {acd, comm?}                 -> Program -> download -> Run -> save
    upload     {acd, comm?, out?}           -> upload running project into <out>

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


def _fail(msg, trace=None):
    emit({"type": "result", "ok": False, "error": msg, "trace": trace})


async def _run(cmd):
    op = cmd.get("op")

    if op == "health":
        # Import is enough to confirm the SDK + its .NET assemblies load.
        from logix_designer_sdk import LogixProject  # noqa: F401
        emit({"type": "result", "ok": True, "op": "health", "sdk": "logix_designer_sdk"})
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

    acd = cmd.get("acd")
    comm = cmd.get("comm") or None
    if not acd:
        _fail("missing 'acd' project path")
        return

    logger = JsonEventLogger()
    emit({"type": "status", "msg": f"Opening project {acd}"})
    project = await LogixProject.open_logix_project(acd, logger)
    try:
        # Resolve communications path: explicit override or the one stored in the ACD.
        if op == "comm_path":
            stored = await project.get_communications_path()
            emit({"type": "result", "ok": True, "op": op, "comm_path": stored})
            return

        if not comm:
            comm = await project.get_communications_path()
        if comm:
            await project.set_communications_path(comm)

        def mode_name(m):
            return str(m).split(".")[-1]

        if op == "status":
            mode = await project.read_controller_mode()
            emit({"type": "result", "ok": True, "op": op,
                  "comm_path": comm, "mode": mode_name(mode)})

        elif op == "mode":
            target = mode_map.get(str(cmd.get("mode", "")).upper())
            if target is None:
                _fail(f"invalid mode '{cmd.get('mode')}' (use PROGRAM|RUN|TEST)")
                return
            await project.change_controller_mode(target)
            mode = await project.read_controller_mode()
            emit({"type": "result", "ok": True, "op": op,
                  "comm_path": comm, "mode": mode_name(mode)})

        elif op == "download":
            emit({"type": "status", "msg": "Switching controller to PROGRAM"})
            await project.change_controller_mode(RequestedControllerMode.PROGRAM)
            emit({"type": "status", "msg": "Downloading project"})
            await project.download()
            emit({"type": "status", "msg": "Switching controller to RUN"})
            await project.change_controller_mode(RequestedControllerMode.RUN)
            await project.save()
            mode = await project.read_controller_mode()
            emit({"type": "result", "ok": True, "op": op,
                  "comm_path": comm, "mode": mode_name(mode)})

        elif op == "upload":
            emit({"type": "status", "msg": "Uploading running project from controller"})
            # upload() pulls the running controller program into the open project,
            # then save() writes it back to the (temp-staged) ACD the caller opened.
            await project.upload()
            await project.save()
            emit({"type": "result", "ok": True, "op": op, "comm_path": comm})

        else:
            _fail(f"unknown op '{op}'")
    finally:
        try:
            project.close()
        except Exception:
            pass


def main():
    try:
        raw = sys.stdin.read()
        cmd = json.loads(raw)
    except Exception as e:
        _fail(f"bad request JSON: {e}")
        sys.exit(1)
    try:
        asyncio.run(_run(cmd))
    except Exception as e:
        _fail(f"{type(e).__name__}: {e}", traceback.format_exc())
        sys.exit(1)


if __name__ == "__main__":
    main()
