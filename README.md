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
