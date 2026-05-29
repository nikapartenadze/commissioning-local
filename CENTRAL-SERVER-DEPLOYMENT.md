# Centralized Server — Deployment & Modularity Plan

> Status: **investigation / plan only** (no Docker files or code yet).
> Branch: `central-tool-latest` (multi-MCM `central-tool` work merged onto `main` @ v2.39.15).
> Decisions taken: deploy target = **validate on Windows now, move to Linux later**; modular split = **design now, build later**.

## 1. What the centralized server is

The `central-tool` design turns the field tool into **one Node process that holds N live PLC connections** — one `PlcClient` per MCM, keyed by `subsystemId`, each with its own libplctag session and network poller (`frontend/lib/mcm-registry.ts`). State lives in two tiers:

- **In-process (volatile):** the registry `Map` of connections + the cached tag values. Lost on restart, rebuilt automatically by reconnecting (`autoReconnect`, ~5 s).
- **SQLite (durable):** IOs, test results, history, config.

There is **already an internal seam**: the PLC layer never talks to browsers directly. It POSTs events to `http://localhost:3102/broadcast` and the WebSocket server fans them out to clients (`mcm-registry.ts` `broadcast()` → port 3102 → `ws://host:3000/ws`). This seam is the foundation of the modularity plan in §4.

### Native dependencies (drive the platform choice)
- **libplctag** via `ffi-rs` — cross-platform; Linux ships a `.so`. The build currently downloads only the **Windows** `plctag.dll` (`deploy/BUILD-PORTABLE.bat`); a Linux image must add the libplctag Linux artifact from the same release.
- **better-sqlite3** — native, compiles per-platform, **single-writer** (one process owns writes; WAL allows concurrent readers). This constraint shapes §4.

## 2. Deployment platform — two-phase

PLC traffic is **Ethernet/IP (CIP) over TCP** to fixed PLC IPs. The host OS is irrelevant *provided the server has a NIC on the PLC subnet/VLAN.* That network path is the thing that actually matters.

### Phase A — validate on the existing Windows device (Docker Desktop, Linux containers)
- Goal: prove the image builds and runs, exercise the multi-MCM flow, shake out the libplctag-on-Linux packaging.
- **Known caveat:** Docker Desktop on Windows puts a NAT layer (WSL2 bridge) between the container and the PLCs. CIP/connected-messaging can misbehave behind NAT. Acceptable for validation; **do not treat Windows-Docker as the production answer.**
- Watch for: connection drops, slow tag reads, or connect failures that don't happen with the native Windows install — these point at the NAT path, not the app.

### Phase B — production on a Linux host
- A small Linux box/VM physically on the plant network, NIC on the PLC VLAN.
- Run the container with **`--network host`** so it uses the host NIC directly — no NAT between the container and the PLCs.
- Lightest footprint, best-supported libplctag path, cleanest container ops and rollback.

## 3. Versioning & rollback

Docker is strictly better than the current NSIS-installer model for rollback:

- Build **one versioned image per release**: `commissioning-central:2.39.15`, matching the existing `vX.Y.Z` tag discipline.
- `docker-compose.yml` pins the image tag via an env var.
- **Rollback = change the tag → `docker compose up -d`.** Seconds. Keep the last N images on the host as instant fallbacks.
- **SQLite + config live in a mounted volume, never in the image** (the portable build already hard-fails if a `.db` leaks into the output). A code rollback therefore never touches data.

## 4. Modularity — hotfix one area without stopping the rest

**Goal:** if IO testing is working and someone hotfixes the network area, don't drop everyone's PLC connections.

**Principle: split by _stateful vs stateless_, NOT by _feature_.**

### Why feature-slicing (separate "IO app" + "network app") is the wrong cut
- They share the **same PLC connection** — one CIP session per controller. Two processes both reading the same PLC fight over its limited connection slots.
- They share the **same SQLite file** — better-sqlite3 is single-writer.
- The feature boundary runs straight through the shared stateful core. High effort, fragile.

### The right cut — along the existing 3102 seam
| Service | Holds | Redeploy frequency | Database |
|---|---|---|---|
| **`plc-gateway`** | PLC connections, tag cache, network pollers; broadcasts on 3102 | Rare | **None** (tag defs pushed in via `loadMcmTags`) |
| **`app`** | API routes, UI, SQLite, cloud sync | Frequent (hotfixes) | Owns SQLite |

- Hotfix to network UI/API or the IO grid → **restart `app` only** → PLC connections + pollers stay live in the gateway → IO testing never blips.
- Restart the gateway only for changes to connection/poller logic itself (rare).
- Feasible rather than a rewrite **because the contract already exists**: the 3102 broadcast + the `mcm-registry` function API. Promoting that internal HTTP hop to a real process boundary is bounded work.
- SQLite single-writer is *satisfied by design*: the gateway needs no DB, so `app` remains the sole writer.

### Phased path
- **Phase 0 (do first):** Dockerize the existing single process. Versioned image, volume-mounted data, `--network host` on Linux. Delivers reproducible deploys + instant rollback now. Restarts still blip connections ~5 s, but contained and instantly reversible.
- **Phase 1 (the modularity goal):** Extract `plc-gateway` from `app` across the 3102 seam; deploy `app` independently of PLC connections.

## 5. Open risks / to verify before building
1. **libplctag on Linux** — confirm the exact release artifact and that `ffi-rs` binds it the same way as the Windows DLL. (Build script change required.)
2. **CIP over `--network host`** — verify connected messaging to a real controller from a Linux container; confirm no NAT in the path.
3. **PLC connection-slot budget** — N MCMs from one gateway must stay within each controller's connection limits (already true in the monolith; preserve in the gateway).
4. **SQLite writer ownership** — lock in "app owns writes, gateway is DB-free" before any split.
5. **Browser reconnect UX on `app` restart** — the app-wide `ConnectionGuard` overlay (fixed in v2.39.15) will show during an `app`-only restart; confirm it clears cleanly when `app` returns and the gateway never dropped.

## 6. Not doing (yet)
- No Docker files, compose, or code changes — this document is the agreed investigation deliverable.
- No feature-sliced microservices (see §4).
