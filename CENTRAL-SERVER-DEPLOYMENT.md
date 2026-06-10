# Centralized Server — Deployment & Modularity Plan

> Status: **Phase 0 + Phase 1 implemented** (Dockerized monolith AND the gateway/app split).
> Branch: `central-tool-latest` (multi-MCM `central-tool` work merged onto `main` @ v2.39.16).
> Decisions taken: deploy target = **validate on Windows now, move to Linux later**; modular split = **built** (§7).

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
- **Phase 0 (do first) — ✅ implemented, see §6.** Dockerize the existing single process. Versioned image, volume-mounted data, `--network host` on Linux. Delivers reproducible deploys + instant rollback now. Restarts still blip connections ~5 s, but contained and instantly reversible.
- **Phase 1 (the modularity goal) — ✅ implemented, see §7.** Extract `plc-gateway` from `app` across the 3102 seam; deploy `app` independently of PLC connections.

## 5. Open risks / status
1. **libplctag on Linux** — ✅ **resolved.** The prebuilt `libplctag.so` requires `GLIBC_2.38`; `node:20-bookworm-slim` (glibc 2.36) cannot load it (`cannot open shared object file`). Fixed by basing the image on **`node:20-trixie-slim`** (Debian 13, glibc 2.41). `ffi-rs` binds it identically to the Windows DLL — confirmed loading in-container via `ldd`. *This bug also affected the Phase 0 image, which had never exercised a real connect.*
2. **CIP over `--network host`** — ⚠️ **still hardware-gated.** The seam, connect flow and tag plumbing are validated end-to-end on Windows Docker Desktop with an unreachable test IP (connection attempt + retry loop confirmed). Connected-messaging against a real controller over `--network host` must be verified on the Linux plant host (Phase B).
3. **PLC connection-slot budget** — unchanged from the monolith: one CIP session per controller, now owned solely by the gateway. Preserved by design.
4. **SQLite writer ownership** — ✅ **locked in.** The gateway is DB-free; it never imports/opens SQLite. The app resolves `ioId → subsystemId` and passes it in the request body, remaining the sole writer.
5. **Browser reconnect UX on `app` restart** — the app-wide `ConnectionGuard` overlay (fixed in v2.39.15) shows during an `app`-only restart and clears when the app returns; the gateway never drops. (Browser-level UX still to confirm with a real session.)

## 6. Phase 0 — implemented (Dockerized monolith)

Files (in `frontend/`, the field tool's own codebase — build context is `frontend/`):

| File | Role |
|---|---|
| `Dockerfile` | Multi-stage. Builder: `npm ci` (prisma copied first for the `postinstall` generate), `npm run build` (Vite → `dist`), `npm run build:server` (tsc → `dist-server`), `npm prune --omit=dev`. Runner: flattens `dist-server` to `/app`, copies `dist`, the hand-written `lib/startup-backup.js`, `libplctag.so`, and the pruned `node_modules`. |
| `docker-compose.yml` | Pins `commissioning-central:${IMAGE_TAG}`, mounts the `commissioning-data` volume at `/data`, `network_mode: host` (Linux/Phase B) with a commented `ports:` fallback for Windows Docker Desktop (Phase A). |
| `.env.example` | `IMAGE_TAG` + `JWT_SECRET_KEY` (copy to `.env`). |
| `.dockerignore` | Keeps `libplctag.so` + source; drops `node_modules`, builds, runtime data, secrets, the Windows `plctag.dll`. |

Layout decisions that make it work:
- **Client-bundle path:** the server does `path.join(__dirname, 'dist')`. The image runs `node /app/server-express.js`, so `dist/` is copied to `/app/dist`.
- **Native lib:** `lib/plc/libplctag.ts` searches `process.cwd()` and `__dirname` — both `/app` — so `libplctag.so` is copied to `/app`.
- **Data path:** `DATABASE_URL=file:/data/database.db` (absolute) so the `/data` volume holds DB + `config.json` + `logs/` + `backups/` (all derived in `storage-paths.ts`) **without shadowing app code** under `/app`. SQLite + config never enter the image (§3).
- **Versioning/rollback (§3):** one image tag per release; rollback = change `IMAGE_TAG` → `docker compose up -d`.

### Runbook
```bash
cd frontend
cp .env.example .env            # set JWT_SECRET_KEY (openssl rand -hex 32)
docker compose build            # or: docker build -t commissioning-central:2.39.16 .
docker compose up -d
docker compose logs -f
# rollback: edit IMAGE_TAG in .env, then: docker compose up -d
```

## 7. Phase 1 — implemented (plc-gateway / app split)

Two containers from **one image**, differing only by `command`. The app redeploys
without dropping the gateway's PLC connections.

### Files
| File | Role |
|---|---|
| `gateway-server.ts` | The **plc-gateway** entrypoint. Express service (default `:3200`) that owns the in-process `mcm-registry` — libplctag connections, tag cache, network pollers. DB-free. Exposes the control API and POSTs tag/connection events to the app's `:3102` receiver. |
| `lib/plc/gateway-protocol.ts` | Shared request/response contract for the control API. |
| `lib/plc/gateway-client.ts` | App-side HTTP client. Every call degrades gracefully (gateway down → "not connected", never a thrown handler). |
| `lib/plc/remote-cache.ts` | App-side read model of gateway state: a `GET /state` poller (~750 ms) plus broadcast-stream patching, so the synchronous registry getters work without a network hop. |
| `lib/mcm-registry.ts` | Made **mode-aware** (`PLC_MODE=remote`): async mutators (connect/disconnect/load-tags/IO writes) RPC the gateway; sync getters read the cache. Embedded (default) path byte-for-byte unchanged. |
| `docker-compose.split.yml` | `gateway` + `app` services. `app` gets `PLC_MODE=remote`, `GATEWAY_URL`, the `/data` volume, and `BROADCAST_HOST=0.0.0.0`. |

### The seam (both directions)
- **Control (app → gateway, `:3200`):** the registry's mutators call the gateway; `getMcmIdForIo` stays app-side (SQLite), so the gateway never needs the DB.
- **Events (gateway → app, `:3102`):** unchanged from the monolith — the registry POSTs `subsystemId`-tagged broadcasts to the app, which fans them out to browsers and patches its read cache. `server-express` now binds the broadcast receiver on `BROADCAST_HOST` (loopback for the monolith, `0.0.0.0` in the split).

### Scope boundary (Phase 1 covers the central-server `/mcm` surface)
- ✅ Covered in remote mode: `/api/mcm/*` (connect/disconnect/status/tags), IO testing (`/api/ios/:id/fire-output|state|test|reset`), `/api/plc/status` aggregate, the heartbeat rollup, and the WS snapshot.
- ⚠️ **Embedded-only in Phase 1** (route through the gateway in 1.1): the legacy single-PLC `/api/plc/connect|disconnect`, and direct-write aux flows (`vfd-commissioning/*`, `safety/fire|bypass`, `guided/*`) that call `getClientForIo().writeOutputBit` directly. In remote mode `getClientForIo` returns a read-only cache shim whose write methods throw — these aux routes are not part of the central `/mcm` testing UI.

### Validated (Windows Docker Desktop, Phase A)
- Both directions of the seam work cross-container.
- An MCM registered on the gateway is read by the app over the cache (`totalMcmCount` reflects it).
- **App container fully recreated → gateway uptime kept climbing, `mcmCount` stayed 1, the restarted app re-read the live MCM.** The connection + autoreconnect loop + tag set survived the app redeploy.
- Embedded monolith still boots clean on the trixie image (no regression).
- Unit tests: `remote-cache` (broadcast patching) + `gateway-client` (protocol + graceful degradation).

### Runbook
```bash
cd frontend
cp .env.example .env                 # IMAGE_TAG, JWT_SECRET_KEY (+ APP_PORT to override the published port)
docker compose -f docker-compose.split.yml build
docker compose -f docker-compose.split.yml up -d
# hotfix the app WITHOUT dropping PLC connections:
docker compose -f docker-compose.split.yml up -d --no-deps app
```
Phase B (Linux): give the `gateway` `network_mode: host` for no-NAT CIP and point the
app's `GATEWAY_URL` + the gateway's `WS_BROADCAST_URL` at the host (see the compose comments).

## 8. Production hardening (no-data-loss / recovery / scale)

The central server holds many testers' work, so "it connects" is not enough.
What's in place:

### Concurrency & no lost updates
- `better-sqlite3` is **synchronous** and the app is a single Node process, so
  every `/api/ios/:id/test` runs its `db.transaction()` (Ios + TestHistory +
  PendingSync) **atomically to completion before the next request's handler
  runs**. Two testers on the same IO serialize (A→v6, then B reads v6→v7) — no
  read-modify-write race. WAL + `synchronous=FULL` + `busy_timeout=5000` back it.
  (Holds because there is exactly one writer — the gateway is DB-free.)
- The cloud push queue is **per-IO single-flight** (`sync-queue`): different
  IOs/MCMs/testers push in parallel (no global bottleneck); rapid edits to the
  *same* IO coalesce to the latest value. Nothing waits on anything else.

### Sync correctness (multi-MCM)
- **Push up:** per-IO, MCM-agnostic; the 30s background retry scans ALL
  `PendingSyncs`. Results from every MCM reach the cloud.
- **Real-time down:** the cloud SSE stream is global (it does not filter by
  subsystem); the local client applies any event whose IO exists locally — so
  all MCMs get live updates through the one connection.
- **Catch-up down:** on SSE reconnect, `pullAllConfiguredMcms()` reconciles
  EVERY active station (was single-subsystem), reusing `POST /api/mcm/:id/pull`
  which 409s on unsynced local work so it can never clobber an un-pushed result.
  Plus a periodic safety pull (`SYNC_SAFETY_PULL_MINUTES`, default 15).

### Recovery & retention
- **Recovery audit log** (`lib/logging/recovery-log`): append-only JSONL of
  every recoverable event — `io.test`, `io.reset`, **`sync.push.drop`** (with
  the full discarded payload, from both drop paths), `server.start`. Daily
  files, `RECOVERY_LOG_RETENTION_DAYS` (default 14).
- **App/error logs**: daily rotation, `LOG_RETENTION_DAYS` (default 14) — was a
  30MB cap that couldn't retain two weeks under load.
- **DB backups**: startup + every `BACKUP_INTERVAL_HOURS` (default 6),
  `BACKUP_RETENTION_DAYS` (default 14, min 3 kept).

### Tag reads at scale (validated)
- 5 CDW5 emulators, **7,317 tags** live: RSS ~268MB, no leak, 0 read failures,
  read batches ~150ms/100 tags. Fire-output / read-state use **direct CIP**
  (immediate), so test actions are never poll-latency-bound even on the
  3,650-tag controller.

### Tuning knobs (env)
`RECOVERY_LOG_RETENTION_DAYS`, `LOG_RETENTION_DAYS`, `BACKUP_RETENTION_DAYS`,
`BACKUP_INTERVAL_HOURS`, `SYNC_SAFETY_PULL_MINUTES`.

## 9. Phase 1.1 — aux flows MCM-aware (mostly done)

Made the aux PLC flows target a specific MCM (they were legacy-singleton, so
broken on the central server) and gateway-routable for split mode. The generic
plumbing: `PlcClient.writeTypedTag/readTypedTag/hammerWriteTags` (VFD raw-FFI
relocated verbatim), gateway batch RPCs (`/tags/write|read|hammer-write`), and
`mcm-registry` mode-aware facades (`writeOutputBitBySubsystem`,
`read/writeTypedTagsForMcm`, `hammerWriteTagsForMcm`).

- ✅ **safety/fire, safety/bypass** — MCM-aware, validated against MCM02.
- ✅ **vfd write-tag, read-tags, write-tags-batch** — MCM-aware; FFI relocated
  verbatim into `PlcClient` (write correctness preserved; needs real-drive
  sign-off — see CENTRAL-SERVER-VALIDATION.md §8).
- ✅ **guided/test, guided/clear** — already split-safe (use cache-backed
  `getPlcTags`, no direct PLC writes).
- ⏳ **Remaining** (still singleton): `vfd/clear`, `safety/status` (small — fit
  the typed facade); `vfd/wizard-open|close` (stateful live reader → must run in
  the gateway for split); `vfd/test-write` (raw-byte diagnostic). See
  CENTRAL-SERVER-VALIDATION.md "Known remaining".

**All validation/verification steps: see [CENTRAL-SERVER-VALIDATION.md](CENTRAL-SERVER-VALIDATION.md)** — incl. the hard rule to **not push test data to the production cloud** while testing.

## Access control & roles

The central server holds many testers' work over the LAN, so it ships **PIN login + JWT + a `Users` table** (`FullName`, bcrypt `Pin`, `IsAdmin`, `IsActive`) with two roles:

- **Tester** — log in, see the MCM list, pick their MCM, connect, and record results. Cannot change configuration.
- **Admin / supervisor** — everything a tester can do, **plus** config: PLC IP/path, the cloud API key, and add/edit/remove MCMs.

Endpoints split accordingly: read + connect/disconnect + test/record are open to any logged-in user; config writes (`POST/PUT/DELETE /api/mcm`, `/api/mcm/cloud-config`, `import-from-cloud`, `pull-all`, `PUT /api/configuration`) require **admin**. The **server laptop itself is blocked from authoring results** (`noTestingOnServerLaptop`, loopback-IP) — it's the PLC broker; testers work from client browsers.

### Turning it on (`AUTH_REQUIRED`)

Auth is **opt-in via the `AUTH_REQUIRED` env var** so the single-laptop field tablet and dev runs stay open-access with zero change:

- **Unset / `0` / `false` / `off` / `no`** → open-access (historical default): no login, every request is treated as admin. Single-subsystem field use and `npm run dev` are unaffected.
- **Set (e.g. `AUTH_REQUIRED=1`)** → enforced: clients must log in with a PIN; `verifyAuth` fails closed (401) on a missing/invalid Bearer token, and the config endpoints above return 403 to non-admins. **Set this in the centralized installer's service environment.**

First run seeds an admin **`Admin` / `111111`** flagged `MustChangePin`, so the first admin login is forced to set a new PIN before anything else. Add the rest of the testers/admins via the Users screen. The client discovers the mode at boot via open `GET /api/auth/mode → { required }` and only shows the login/change-PIN gate when enforced.

> Status: **shipped on `central-tool-latest`** (commit `a548394`) — built, both modes unit-tested (397 pass), client build + server typecheck clean. DNS/host-name discovery for clients is **deferred pending discussion** (backlog TSK-2196 — clients reach the server by `<laptop-ip>:3000` today).

## 10. Not doing (yet)
- Delta sync (the catch-up pull is a full per-subsystem delete+reinsert; ~6–8s
  ×N on reconnect — correct and pending-guarded, but heavier than a since-version
  delta would be).
- No feature-sliced microservices (see §4).
