# Central-Server (multi-MCM) correctness audit — 2026-06-19

Four parallel code audits (sync, data views, logs/backups/DB, PLC connect/status).
Bug class hunted: a single `config.subsystemId` / legacy singleton used where the
central server needs PER-MCM (the class behind the SSE-"Red", firmware-singleton,
shared-L2, and network-status-singleton incidents).

## Verdict
**NOT fully ready.** The **data-integrity + safety backbone is correct per-MCM**
(writes, drain, scoped pulls+backups, per-IO routing, and crucially the
**VFD/polarity writeback** — belts safe). But **multiple read/status/push/observability
paths are still single-MCM**, so on a central server several views show wrong/grey
data and you can't tell per-MCM what's stuck. These must be fixed before site.

## ✅ Confirmed correct per-MCM (no action)
- Per-MCM connect/reconnect/disconnect/status; per-IO read/write routing with the
  cross-MCM-misroute safety guard (`mcm-registry.ts`).
- **VFD/polarity writeback runs per connected MCM** (`vfd-validation-writer.ts`) — belt-reversal path safe.
- Push **drain** covers all MCMs (by row identity); per-MCM pulls do scoped DELETE + scoped pre-pull backup (aborts on failure); L2 pull preserves other MCMs.
- DB schema: every MCM-specific table is scoped (`SubsystemId` or FK chain); no remaining collision bug. Backups capture the WHOLE DB (all subsystems).
- Already-fixed: `pushNetworkStatus`, per-MCM L2, SSE/backup/firmware-device-snapshot, safety/estop **status reads**, VFD wizard writes, heartbeat rollup.

## ❌ Gaps to fix (prioritized)

### BLOCKER / HIGH — break central-server function or required observability
| # | Gap | File | Fix shape |
|---|---|---|---|
| 1 | **`pushEstopStatus` single-MCM + singleton-gated** → E-Stop/safety status never reaches cloud for any MCM on central (all "Red") | `lib/cloud/auto-sync.ts:1547` | mirror `pushNetworkStatus` — iterate active MCMs, per-MCM registry status |
| 2 | **`/api/network/status` singleton-only** → network topology view all-grey for the fleet | `app/api/network/status/route.ts:21,75` | mirror `safety/status`/`estop/status`: `readTypedTagsForMcm` per subsystem + legacy fallback |
| 3 | **ring-status singleton-only** (`getLatestRingStatus`) → guided D5 DPM-ring gate returns null for all MCMs | `lib/plc-client-manager.ts:405`, `app/api/guided/system-status/route.ts:24` | registry-aware per-MCM ring getter; route takes subsystemId |
| 4 | **`NetworkDiagnosticsView` has no `subsystemId` prop**; firmware/diagnostics fetches unscoped → shows one/wrong MCM | `components/network-diagnostics-view.tsx` | accept + thread `subsystemId`, scope its fetches |
| 5 | **Sync-status surface global, not per-MCM** → can't see which MCM is stuck/synced | `app/api/cloud/status/route.ts:13-86` | group counts by subsystem (join `Ios`/`L2Devices`); per-MCM badges |
| 6 | **Drop/park audit events omit `subsystemId`** → dropped result/FV not MCM-filterable in durable log | `auto-sync.ts:301,423,547,1040+`, `pending-sync-utils.ts:68` | add `subsystemId` (IO via `Ios` join; L2 needs attribution) |

### MEDIUM
| # | Gap | File |
|---|---|---|
| 7 | `pushNetworkDiagnostics` single-MCM + singleton | `auto-sync.ts:1653` (use `getAllNetworkSnapshots()` per subsystem) |
| 8 | `scanController` reads only first connected MCM's controller | `lib/plc/identity/firmware-service.ts:114,145` (iterate MCMs) |
| 9 | `sync.pull`/`plc.connect`/`plc.disconnect` audit types declared but NEVER emitted → destructive pulls leave no recovery-log trace | `lib/logging/recovery-log.ts:32`, emit in pull/connect |
| 10 | Real-time SSE subscribes to ONE subsystem (others only via reconnect/15-min pull) | `cloud-sse-client.ts:128` — by-design fallback exists; true real-time is single-MCM |
| 11 | `Punchlists` PK is cloud `id` (cross-MCM REPLACE risk if id-spaces overlap) | `db-sqlite.ts:569` |
| 12 | `/api/cloud/sync-pull` polling fallback single-subsystem | `app/api/cloud/sync-pull/route.ts:7` |

### LOW
- Dual backup-prune policies (count 300 vs 14-day) on same dir — unify.
- `logger.*` suppressed in prod; sync diagnostics rely on raw `console.*`.
- `chain-status` aggregate-only; legacy `/api/plc/disconnect` doesn't tear down registry MCMs.

## Deployment note (separate from code)
The central server must have **adequate RAM** — the battle I5 restarts were container OOM; with realistic memory everything passed.

## Fix order
1–6 (HIGH) before site, then 7–9, then re-run the `central` battle gate. The
template for 1/2/3/7 is the already-correct `pushNetworkStatus` / `safety/status`
per-MCM pattern — mechanical application.
