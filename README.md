# Commissioning Tool

Field commissioning tool for industrial PLC systems. Used by technicians on tablets and laptops to test, validate, and commission conveyor and VFD systems on-site. Runs either as a **single-laptop field tool** or as a **centralized server** that drives many MCMs from one machine over the site LAN.

> **In progress:** [FV-HARDENING-PLAN.md](FV-HARDENING-PLAN.md) — fail-loud FV saves, cloud-controlled minimum-version lockout, and fleet startup/outdated alerts, following the 2026-07-11 MCM04/MCM11 FV data-loss incident. Implementation is partially in the working tree (this repo + `commissioning-cloud/`).

## What It Does

- Connects to Allen-Bradley PLCs over Ethernet/IP
- Reads and writes PLC tags in real-time via WebSocket
- VFD commissioning wizard (identity, HP, bump test, controls, speed calibration)
- L2 Functional Validation spreadsheet with pass/fail tracking
- I/O point testing with live state monitoring
- **Guided Mode** — a priority-driven task pool that walks the tester one step at a time on the live SCADA SVG map (navigate → check → auto-pass/fail → next task)
- **E-Stop dual safety verification** — Preliminary (zone-stop / positive) + Final (selectivity / negative) per pull cord
- Offline-first with local SQLite database; **queue-and-retry sync** to the cloud (local is authoritative — no data loss)
- Safety zone and E-Stop verification
- Network topology + DLR ring-health visualization

## Deployment modes

- **Single-MCM field laptop** — the classic one-laptop-per-MCM flow (embedded, single process).
- **Centralized multi-MCM server** — one laptop runs the server; each MCM is an entry at `/api/mcm/:subsystemId/…`, listed on the `/mcm` landing page. For scale it runs **split** (an `app` process + a `plc-gateway` process owning all PLC connections, `PLC_MODE=remote`) so the app event loop never blocks. A single subsystem is just the N=1 case — the centralized build is a superset of the single-laptop one.

## Access & roles (rolling out)

The tool ships a built-in **PIN login + JWT + `Users` table** with two roles:
- **Tester** — log in, pick their MCM, connect, and record results.
- **Admin/supervisor** — everything testers can do, plus configuration (PLC IP/path, cloud API key, add/edit/remove MCMs).

> Note: open-access mode (everyone effectively admin) is the historical default; role enforcement on the centralized server is being switched on (see the auth/RBAC work on `central-tool-latest`).

## Tech Stack

- **Client:** Vite + React 18 + React Router
- **Server:** Express 5 + TypeScript
- **Database:** SQLite (better-sqlite3)
- **PLC:** libplctag via ffi-rs
- **Realtime:** WebSocket on port 3000

## Quick Start

```bash
cd frontend
npm install
npm run dev
```

- Vite client: http://localhost:5173
- Express API + WebSocket: http://localhost:3000

## Distribution

Ships as a portable ZIP (~42 MB) or Windows NSIS installer (~55 MB). No installation required for portable mode — extract and run `START.bat`.

```bash
# Build portable
cd deploy
powershell -ExecutionPolicy Bypass -File build-portable-auto.ps1

# Or use the batch file
BUILD-PORTABLE.bat

# Or the full installer (portable + NSIS)
BUILD-INSTALLER.bat
```

## Auto-Update (v2.38.0+)

Tablets running v2.38.0 or later can be updated remotely with one click from the commissioning-cloud admin UI — no walking around the site with a USB stick.

### How it works

```
Admin clicks "Push update" on a tablet card
  → POST /api/admin/instances/:id/commands { type: "update" }
  → row queued in laptop_commands (status: pending)
  → tablet's next heartbeat (≤30 s) picks the command up
  → tablet spawns tools/install-update.ps1 detached
  → ps1: backs up DB+config, stops service, runs installer /S, restarts, /api/health check
  → tablet's next heartbeat reports the new version → card flips
```

Total round-trip: ~60–120 s depending on installer size and link speed.

### What the tablet looks for

`lib/update/update-utils.ts` resolves the release manifest URL in this order:

1. `UPDATE_MANIFEST_URL` env var
2. `updateManifestUrl` field in `config.json`
3. **Default**: `https://commissioning.autstand.com/api/releases/latest`

So every v2.38.0+ tablet gets self-update for free, no per-tablet config edit.

### Safeties

- Refuses downgrades (`compareVersions(requested, current) <= 0` → no-op)
- Refuses stacked installs (one update in flight at a time)
- Refuses on non-Windows
- Validates `http(s)://` on the installer URL before spawning
- Backs up `database.db` and `config.json` to `backups/` before every install — restore by copying back if anything goes wrong

### Bootstrap state

**v2.38.1 is the last manual install.** (v2.38.0 was published briefly but superseded by v2.38.1, which folds in the UDT-network-polling performance fix; install v2.38.1 directly — you don't need v2.38.0.) Tablets on builds older than v2.38.0 don't recognize the `update` command — the cloud will still queue it, but the laptop reports `failed: unknown command type` in the fleet UI, telling the admin which tablets still need a manual install.

### Shipping a new release (e.g. v2.39.0)

1. Bump `frontend/package.json` and `deploy/BUILD-INSTALLER.bat` to `2.39.0`
2. `cd commissioning-local && rmdir /s portable && deploy\BUILD-INSTALLER.bat` (produces `CommissioningTool-Setup-v2.39.0.exe`)
3. Commit, tag `v2.39.0`, push, create the GitHub release with the `.exe` attached
4. Copy the `.exe` to `commissioning-cloud/public/downloads/`
5. `cd commissioning-cloud && .\deploy.ps1` (builds + pushes Docker image to `registry.lci.ge/commissioning/app:latest`)
6. `ssh dockerhost "cd /home/adminuser/apps/commissioning && docker pull registry.lci.ge/commissioning/app:latest && docker compose down && docker compose up -d"`
7. Verify `curl https://commissioning.autstand.com/api/releases/latest` returns the new version
8. Open the cloud admin UI → fleet tab → click **Push update** on each tablet. Cards flip to the new version as each tablet finishes installing.

The manifest endpoint auto-picks the highest semver in `public/downloads/` — leaving older `.exe`s there is harmless but bloats the image. Prune to the last two or three on each release.

## Per-Tablet Runtime Config

A handful of fields in `config.json` (lives at `C:\ProgramData\CommissioningTool\config.json` for installer builds, or beside `database.db` for portable) let you tune behavior per tablet without redeploying. The `ConfigurationService` hot-reloads on file change — most fields take effect immediately; cadence-sensitive ones noted below need a service restart.

| Field | Default | Effect | Hot-reload? |
|---|---|---|---|
| `networkPollingIntervalMs` | `60000` (60 s) | UDT_NETWORK_NODE_DATA poll cadence. Lower it (down to `1000`) only for active field debugging — every poll queues N parallel CIP requests against the same controller the IO tag reader hammers at ~75 ms × 600+ tags. The cloud heartbeat already downsamples to 60 s, so faster polling here doesn't give the cloud fresher data. Clamped to `[1000, 600000]` by the loader. | Restart needed (the poller is started once at PLC connect). |
| `requireInstalledForTesting` | `false` | When `true`, rejects Pass/Fail attempts on any non-SPARE IO whose `installationStatus` is not `'complete'`. Used on projects like CDW5 where mechanical installation must be signed off before testing is allowed. | ✅ — server reads `getConfigSync()` on every test attempt. |
| `updateManifestUrl` | (empty → defaults to `https://commissioning.autstand.com/api/releases/latest`) | Where the auto-update manifest lives. Override for staged-rollout scenarios or when pinning a tablet to a private build channel. | ✅ on next manifest fetch. |
| `subsystemId`, `apiPassword`, `ip`, `path`, etc. | per tablet | Existing PLC and cloud-sync settings. | Mixed — see `lib/config/config-service.ts`. |

### Why `networkPollingIntervalMs` matters

The UDT poller used to run every 5 s by default. On busy controllers this caused noticeable lag in the IO testing grid because every cycle queued N parallel CIP requests against the same PLC the IO tag reader was already hammering. v2.38.1 ships with a 60 s default; if you ever see field techs report IO lag again, the diagnosis steps are:

1. Confirm tablet is on v2.38.1+ (heartbeat in cloud fleet view shows the `version` field).
2. Check `config.json` for an override that's been dropped to 5000 — if so, restart service to clear it.
3. If still slow, look at `components/network-status-breadcrumbs.tsx` — it has a *separate* 5 s polling loop that reads `:I.ConnectionFaulted` bits per node. That's the next CIP load source if v2.38.1 alone isn't enough.

## Project Structure

```
frontend/
  app/api/          # Express route handlers
  components/       # React UI components
  lib/              # Database, PLC, sync, config services
  routes/           # Express router mount table
  server-express.ts # Production server entry point
  src/              # Vite client entry point
deploy/             # Build scripts, installer, batch templates
```

## Ports

| Port | Purpose |
|------|---------|
| 3000 | HTTP server + WebSocket |
| 3102 | Internal broadcast API (localhost only) |
| 5173 | Vite dev server (dev only) |

## Multi-MCM Architecture Notes (central-tool branch)

OK, looking at the L5X: the MCMs are running **1756-L83ES ControlLogix 5580 safety controllers on firmware v36.13**. Modern hardware, but native MQTT publishing from this controller class is essentially not a thing in practice — Rockwell expects you to use FactoryTalk Edge Gateway or a separate bridge. So **libplctag stays** as the way you read tags. That's settled.

Now let me re-frame the whole thing honestly, because the original scaling concern actually mixes two different scaling problems that have different answers:

### The two bottlenecks

**A. Server ↔ PLCs over Wi-Fi** (server pulling thousands of tags from 10 MCMs)
**B. Server ↔ multiple browsers** (everyone's browsers asking for live values)

**MQTT-as-broker only fixes B. It does nothing for A.**

Because the L83ES can't publish MQTT itself, anything reaching the broker had to be polled by libplctag first. Adding MQTT downstream of libplctag doesn't reduce the EIP traffic to the PLCs — it just changes who gets the values after libplctag reads them.

### Where MQTT genuinely earns its place (problem B)

This is the part the intuition is correct about. The scenario "I test IO X on MCM03, my colleague is also on MCM03 and sees it instantly" is **exactly** the MQTT sweet spot:

- Server publishes to topic `mcm/03/io/X`
- Both browsers are subscribed to `mcm/03/io/+`
- Broker fans out — server doesn't track who's looking at what
- A third browser on MCM07 subscribes to `mcm/07/io/+` and never sees MCM03 traffic

You can do this with plain WebSocket too (server broadcasts and clients filter, or server maintains a per-client subscription map). But MQTT gives you **topic-based subscriptions for free** — every browser session naturally maps to a per-MCM topic prefix, and the broker handles filtering. That's the real reason it scales better across multiple clients: the server stops being the fan-out bottleneck.

### What MQTT does NOT fix (problem A — the PLC-side concern)

If 10 MCMs × thousands of tags over Wi-Fi is actually the bottleneck, the levers that move the needle are:

1. **Wire the MCMs**, don't run on Wi-Fi for the PLC link (Wi-Fi for clients is fine)
2. **Demand-based polling** — only poll tags the active UI sessions need, not the whole tag tree
3. **Increase polling intervals** for tags that aren't being actively tested
4. **Per-MCM connection pooling** in libplctag (multiple parallel sessions to one MCM for higher throughput)

None of these are MQTT. They're libplctag-layer optimizations.

### Concrete proposal for the stated goal

The architecture described — single server, configurable MCM connections, per-MCM endpoints, same PLC behavior, cloud sync on pass/fail — can be built in two layers:

```
┌─────────────────────────────────────────────────────────────┐
│  Single server (one instance, runs on one box)              │
│                                                              │
│  ┌──────────────────┐    ┌──────────────────┐               │
│  │ MCM Connection   │    │ MCM Connection   │  ... up to N  │
│  │ Pool: MCM03      │    │ Pool: MCM07      │               │
│  │  (libplctag)     │    │  (libplctag)     │               │
│  └────────┬─────────┘    └────────┬─────────┘               │
│           │                       │                          │
│           ▼                       ▼                          │
│  ┌──────────────────────────────────────────┐               │
│  │  Internal pub/sub (MQTT broker or just   │               │
│  │  in-process event emitter to start with) │               │
│  └──────┬───────────────┬──────────────┬────┘               │
│         │               │              │                     │
│         ▼               ▼              ▼                     │
│  WebSocket/MQTT    Cloud sync     SQLite writer              │
│  to browsers       worker         (pass/fail records)        │
└─────────────────────────────────────────────────────────────┘
       ▲                    │
       │                    ▼
   browsers              commissioning-cloud
   (subscribe to        (HTTP or MQTT publish)
    mcm/{id}/...)
```

### Honest recommendation

**Phase 1 (do this first):** Multi-MCM connection pool in libplctag, per-MCM REST/WebSocket endpoints, configurable MCM list in UI/config. Use plain WebSocket for browser updates *for now*. Get the singleton-controller assumption out of the codebase. This is the hard part and it's where 80% of the value lives.

**Phase 2 (only if needed):** If browser-side scaling issues actually appear with 5+ commissioners on the same MCM, swap WebSocket for MQTT-over-WebSockets. The architecture above makes this a non-invasive change — only the transport layer for the "browser subscriber" arrow changes.

**Phase 3 (separate decision):** Cloud sync over MQTT instead of HTTP. Independent of phases 1 and 2.

The honest reason for this order: Phase 1 is the architectural shift that actually makes a single-device, multi-MCM tool possible. Phases 2 and 3 are optimizations that can be deferred until there's evidence they're needed. MQTT is a real tool with a real role here, but the "scale problem" framing slightly overstates what it solves — it's a fan-out layer, not a PLC-traffic reducer.

## Controller capability research (1756-L83ES, firmware v36.13)

### What v36 firmware actually adds

Research into the Rockwell documentation confirms that the **new connectivity feature in v36 firmware is native OPC UA server support, not native MQTT**. Sources:

- Rockwell user manual 1756-UM023: *OPC UA in 5590, 5580, and 5380 Logix Controllers Enabled from V36 firmware*
- Inductive Automation forum thread: *Logix v36 Adds OPC UA Support*
- 1756-L83ES product page (rockwellautomation.com) — lists EtherNet/IP as native; no MQTT
- v36 firmware revision history page — no MQTT references

The 1756-L83ES supports up to **1500 OPC UA nodes** when this feature is enabled. Forum reports describe the v36 OPC UA implementation as immature, with v37 recommended for production maturity — worth verifying with the Rockwell rep before depending on it.

### What "MQTT on the controller" actually means in this context

"MQTT support" on a 1756-L83ES generally refers to one of four distinct things, with very different implications:

1. **Native MQTT publisher in firmware** — not present on 1756-L8x in v36 / v37 / v38 per the documentation reviewed.
2. **MQTT client implemented in ladder via `SOCKET` MSG instructions, packaged as an Add-On Instruction (AOI).** This is real and available, but it is custom ladder logic running inside the controller's user scan, not a firmware feature.
3. **MQTT via a separate module** (e.g. 1756-EN4TR with newer firmware, ProSoft, FactoryTalk Edge Manager / Smart Object). The PLC itself is not publishing — an adjacent device is.
4. **MQTT via FactoryTalk Optix / FT Edge** running on a panel PC next to the controller.

Only option 1 would let us delete the libplctag read path entirely. Options 2-4 keep the data plane downstream of the controller.

## libplctag vs AOI-MQTT for reading tags during commissioning

**Direct answer: AOI-MQTT for tag reads is worse than libplctag on essentially every axis that matters for a commissioning tool. This isn't a "depends" — it's a fairly clear-cut technical mismatch for this workload.**

### How each one actually works on the controller

libplctag uses CIP's native multi-service messaging. A single network request bundles up to ~500 tag reads, the PLC responds in one shot, and no ladder logic is involved. The PLC's EtherNet/IP responder runs as part of the comms task, **separate from the user scan**, so it doesn't compete with the safety/control logic for scan time. It's the exact path the controller is built to serve.

AOI-MQTT runs **inside the user scan**. Every tag publish is ladder work: format an MQTT packet, push it to the socket, manage connection state, handle retries. To publish N tags the AOI has to execute across many scans. The PLC's scan time becomes a hard ceiling on publish throughput, and the cost grows with the published tag count.

### Concrete comparison

| | libplctag | AOI-MQTT |
|---|---|---|
| Throughput | 1000-5000+ tags/sec per controller | ~50-200 tags/sec per controller (scan-time bound) |
| Latency to fresh value | 5-50ms round-trip | PLC scan time (10-50ms) + broker hop |
| Read dynamic tags (not pre-configured) | Yes, just by name | No — every tag must be in the ladder publish list |
| Writes | Native, simple, atomic | Awkward — needs a command-topic AOI on the PLC plus a custom ack flow |
| PLC scan-time cost | Zero | Non-trivial, grows with tag count |
| Socket resource usage on PLC | Zero | Consumes scarce socket connections |
| Operational cost to add a new tag | Edit a config in the app | Edit ladder, download, re-verify safety logic |
| Works on a safety controller without ladder mods | Yes | No — requires modifying SIL2/PLd ladder |

### Why this matters specifically for commissioning

Commissioning is not a SCADA workload. It is not "watch the same 50 KPIs forever." It is:

- Reading **thousands of distinct tags** during a session — every I/O point, every drive parameter, every UDT member, every safety circuit
- Writing tags constantly — test outputs, drive parameter changes, forced I/O states, validation flags
- Touching **different tag sets per test scenario** — a VFD bump test exercises a different set of tags than safety zone verification or I/O point checks

AOI-MQTT is the wrong model for all three of those. It is built for "publish these N pre-configured values continuously" — a steady-state monitoring feed where the tag list is known in advance and rarely changes. Commissioning is the opposite shape: wide, dynamic, write-heavy, and short-lived per session.

### Where AOI-MQTT genuinely fits

AOI-MQTT is a real, useful tool — just for a different application than commissioning:

- **Production-phase monitoring**: the line is running, the OEM publishes throughput/fault/state KPIs to a central dashboard. Fixed tag set, modest rate, fire-and-forget.
- **Edge-to-cloud telemetry**: PLC pushes a curated subset of runtime values to AWS IoT / Azure IoT Hub / a Sparkplug broker on change.
- **Loose coupling**: where multiple unrelated systems need the same fixed signal stream and the goal is to avoid all of them polling the PLC independently.

None of those describe what a commissioning tool does.

### What would actually improve performance if libplctag has pain points

If there is a real performance concern with the current read path, the fixes live at the libplctag layer, not in the protocol choice:

1. **CIP multi-service batching** — ensure reads are being bundled, not issued one tag per request.
2. **Tag selectivity** — only poll tags the active UI session is showing, not the full tag tree.
3. **Per-controller connection pooling** — multiple parallel EIP sessions to a single controller for higher aggregate throughput.
4. **Wired Ethernet to the MCMs** if Wi-Fi is the actual bottleneck.

Each of these is meaningful, and all of them keep the controller untouched.

### Summary

libplctag is the right primitive for commissioning because the PLC's CIP responder is more efficient at serving reads than the user scan is at publishing MQTT, because the tag surface is wide and dynamic, and because writes are first-class operations. AOI-MQTT is a good fit for steady-state telemetry of a small fixed tag set, not for commissioning.
