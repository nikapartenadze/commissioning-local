# Logix SDK bridge

Drives the Rockwell **Logix Designer SDK** (program **download**, upload, and
controller **mode** control) for the commissioning tool's "Program Download"
feature. **Windows-only** — requires a licensed **Studio 5000** plus the **Logix
Designer SDK** (`LdSdkServer.exe`) installed on this node.

`bridge.py` reads one JSON command on **stdin** and emits newline-delimited JSON
(NDJSON) events on **stdout** (`progress` / `status` / `error` / final `result`).
The Node backend (`../lib/logix-sdk-bridge.ts`) spawns the venv Python with this
script and parses those events.

## Setup (per machine)

Requires **Python 3.12 or 3.13** — *not* 3.14 (the SDK wheel pins `<3.14`).

```cmd
py -3.13 -m venv .venv
.\.venv\Scripts\python -m pip install "C:\Users\Public\Documents\Studio 5000\Logix Designer SDK\python\logix_designer_sdk-2.0.2-py3-none-any.whl"
```

The `.venv/` is git-ignored (machine-specific, large) — recreate it with the
steps above on each download node.

## Configuration (env, all optional)

| Env | Default | Purpose |
|-----|---------|---------|
| `LOGIX_SDK_PYTHON` | `./.venv/Scripts/python.exe` | Python that has the SDK wheel |
| `LOGIX_SDK_BRIDGE` | `./bridge.py` | this script |
| `LOGIX_PROJECTS_DIR` | `~/Desktop/plc` | directory scanned for `.ACD` projects |

Point these at a remote Windows node for the eventual Linux-tool + Windows-VM
split (the field tool stays Node + libplctag; only this node needs Python + SDK).

## Quick test

```cmd
echo {"op":"health"} | .\.venv\Scripts\python.exe bridge.py
```
