# Controller Programming Deployment (Logix Designer SDK)

How to stand up the **Program Download / Upload / Mode** feature of the field
tool. This programs live Allen-Bradley Logix controllers **without a human
driving the Studio 5000 GUI** — but it still runs on the licensed Rockwell
engine under the hood.

> **Read first:** `frontend/logix-sdk-bridge/README.md` covers the per-machine
> venv setup. This document is the higher-level topology + operations runbook.

---

## What this is (and isn't)

- **Is:** headless download/upload/mode control by driving Rockwell's **Logix
  Designer SDK** (`LdSdkServer.exe`) — no GUI, no operator clicking through
  Studio 5000.
- **Is not:** a Rockwell-free reimplementation. The node that programs
  controllers **must** have a licensed **Studio 5000** + the **Logix Designer
  SDK** installed and **FactoryTalk Activation** running. (The from-scratch,
  zero-Rockwell CIP download path remains blocked on the auth/MAC crypto — see
  the `vendor-lockout` investigation notes.)

Everything else the field tool does — connect, configure, read I/O, mark
pass/fail, sync — needs **none** of this and runs on any tablet/laptop.

---

## Topology

Two supported shapes. The feature degrades cleanly (button shows "not available
on this station") wherever the SDK is absent, so a mixed fleet is fine.

### A. Single engineering laptop (PoC / small site)

The tool, Studio 5000, and the SDK all live on one Windows box. Nothing to wire
— `provision.ps1` builds the venv at install time and the feature lights up.

### B. Split: Linux/field tool → Windows download-node (recommended for prod)

```
 Field / central tool (Linux or any OS)          Windows engineering node
 ─ Node + libplctag                               ─ Studio 5000 + Logix SDK
 ─ all commissioning + tag I/O          ── HTTP ─▶ ─ logix-sdk-bridge (.venv py3.13)
 ─ controller-console UI                          ─ LdSdkServer.exe (Rockwell engine)
```

The field tool holds no Rockwell dependency; only the one Windows node does.
Point the field tool's bridge env vars (below) at that node.

---

## Requirements on the download-node

| Requirement | Notes |
|-------------|-------|
| Windows | SDK + engine are Windows-only |
| Studio 5000 (v36) + Logix Designer SDK | `LdSdkServer.exe` present; wheel at `C:\Users\Public\Documents\Studio 5000\Logix Designer SDK\python\logix_designer_sdk-*.whl` |
| FactoryTalk Activation | must be **running/licensed** or SDK ops fail |
| Python **3.12 or 3.13** | the SDK wheel pins `<3.14`; the machine default 3.14 is rejected |

---

## Setup

The installer runs `provision.ps1` automatically (best-effort — it exits quietly
and leaves the feature disabled if Studio 5000 / the wheel / a compatible Python
are missing). To provision by hand on any download-node:

```cmd
cd <install>\app\logix-sdk-bridge
powershell -ExecutionPolicy Bypass -File provision.ps1
```

Or the raw venv steps (see the bridge README):

```cmd
py -3.13 -m venv .venv
.\.venv\Scripts\python -m pip install "C:\Users\Public\Documents\Studio 5000\Logix Designer SDK\python\logix_designer_sdk-2.0.2-py3-none-any.whl"
```

The `.venv/` is git-ignored and machine-specific — recreate it per node.

---

## Configuration

### Bridge (all optional; defaults work for the single-laptop case)

| Env | Default | Purpose |
|-----|---------|---------|
| `LOGIX_SDK_PYTHON` | `./logix-sdk-bridge/.venv/Scripts/python.exe` | Python that has the SDK wheel |
| `LOGIX_SDK_BRIDGE` | `./logix-sdk-bridge/bridge.py` | the NDJSON worker |
| `LOGIX_PROJECTS_DIR` | `~/Desktop/plc` | folder scanned for `.ACD` projects (also scans its `uploads/` subfolder) |

For split topology (B), point these at the Windows node's paths.

### SharePoint auto-push (optional — "Upload all" only)

After a batch upload, each produced `.ACD` can be pushed to a SharePoint
document library via **Microsoft Graph, app-only (Entra client-credentials,
`Sites.Selected`)**. Absent/disabled → the whole path is a silent no-op; upload
still succeeds locally.

Set in `config.json` under a `sharepoint` block, or via env (env wins):

| config.json | Env override | Required |
|-------------|--------------|----------|
| `tenantId` | `SHAREPOINT_TENANT_ID` | yes |
| `clientId` | `SHAREPOINT_CLIENT_ID` | yes |
| `clientSecret` | `SHAREPOINT_CLIENT_SECRET` | yes (keep out of git) |
| `siteUrl` | `SHAREPOINT_SITE_URL` | yes, e.g. `https://contoso.sharepoint.com/sites/Commissioning` |
| `folderPath` | `SHAREPOINT_FOLDER` | no (target subfolder) |
| `enabled` | — | set `false` to hard-disable |

Push is considered configured only when `enabled !== false` **and** all four of
tenantId/clientId/clientSecret/siteUrl are present.

---

## Verify

1. **Health** — from the tool host:
   ```
   GET /api/controller-management/health   →  { "ok": true }
   ```
   If `ok:false`, the `reason` explains it (SDK missing, wrong Python, etc.) and
   the UI shows "Program download isn't available on this station."

2. **Bridge smoke test** (on the node):
   ```cmd
   echo {"op":"health"} | .\.venv\Scripts\python.exe bridge.py
   ```

3. **SharePoint config presence** (no network call):
   ```
   GET /api/sharepoint/status
   ```

4. **End-to-end** — open an MCM → Controller console → pick a program → Read →
   confirm mode → Download. A real target should go PROGRAM → transfer → RUN.
   Prefer a Logix Echo emulator for first validation, never a live safety
   controller in RUN.

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| "not available on this station" | SDK/wheel/Python missing on that node — rerun `provision.ps1`; check the health `reason` |
| venv created but `import logix_designer_sdk` fails | wheel/deps mismatch; recreate venv with `py -3.13` |
| Python found but rejected | it's 3.14 — install 3.12/3.13, the wheel pins `<3.14` |
| Download/Read hangs ~20s then works | expected — going online is as slow as Studio 5000; the UI shows a live "going online" readout, not a freeze |
| "ACD is locked" / open elsewhere | close the project in the Studio GUI; the bridge copies to a temp file to dodge the lock, but a held lock on the source still blocks |
| SharePoint step skipped | not configured (missing one of the four required fields, or `enabled:false`) — upload still saved locally |

---

## Safety

- Download/mode changes stop the controller (PROGRAM) then return it to RUN. The
  UI gates every such op behind a themed confirm dialog naming the MCM.
- Do **not** point download experiments at a live safety GuardLogix in RUN. Use a
  Logix Echo emulator for protocol/setup validation.
