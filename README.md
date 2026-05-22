# Commissioning Tool

Field commissioning tool for industrial PLC systems. Used by technicians on tablets and laptops to test, validate, and commission conveyor and VFD systems on-site.

## What It Does

- Connects to Allen-Bradley PLCs over Ethernet/IP
- Reads and writes PLC tags in real-time via WebSocket
- VFD commissioning wizard (identity, HP, bump test, controls, speed calibration)
- L2 Functional Validation spreadsheet with pass/fail tracking
- I/O point testing with live state monitoring
- Offline-first with local SQLite database
- Syncs results to cloud when connected
- Safety zone and E-Stop verification
- Network topology visualization

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
```

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
