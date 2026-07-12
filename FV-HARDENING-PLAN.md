# FV Hardening Plan — fail-loud saves, version lockout, fleet alerts

Status: **implemented, awaiting review** (2026-07-12). All work packages
(F1–F8, C1–C7) are implemented in the working trees of this repo and
`commissioning-cloud/` on the main dev machine — uncommitted until review.
Field suite: 780 tests green (was 735). Cloud suite: 375 green. This doc is
the plan of record so work can resume at any point.

## Why (the 2026-07-11 MCM04/MCM11 incident, condensed)

A tech's Functional Validation checks for MCM11 ENC devices "disappeared".
Forensics on the box's data dump (`mcm04/`, 24 backups + WAL + logs + cloud):

1. **07:47 local** — a manual "pull MCM49" ran v2.42.10's **destructive L2 pull**
   (`DELETE FROM L2CellValues/L2Devices WHERE SubsystemId = ? OR SubsystemId IS
   NULL` + reinsert cloud payload). Device rows were re-created with new local
   ids. This same mechanism had already blanked 9 of Peter Scott's TPE notes on
   07-10 (recovered — values were still intact on cloud; they come back on the
   next FV pull once the box runs ≥ v2.43.0).
2. **10:22–10:39 local** — the tech's browser tab (opened before the pull) was
   posting checks against the deleted device ids: **114 consecutive
   `POST /api/l2/cell → 500 SQLITE_CONSTRAINT_FOREIGNKEY`**, zero persisted,
   zero queued. The client swallowed every 500 and painted green checkmarks.
   A refresh erased the only copy (browser memory). Unrecoverable.
3. Cloud connectivity was fine all day — irrelevant to the loss. Meanwhile every
   cloud heartbeat 400'd (strict Zod vs central-box payload), so the fleet view
   couldn't even show the box's version.

**v2.43.0 (`545dd4f`, `949be8d`, on top of v2.42.11 `efc0cde`) removes the
mechanism**: no DELETEs, upsert by CloudId, filled local cells never overwritten
by a pull, no stale-id storms. The remaining institutional problem: **boxes kept
running old versions** and nobody knew. Hence this plan.

## The mandate (Nika + lead engineer)

- No optimistic UI: "It either works or it doesn't" — a failed save must be
  loud, never a green checkmark.
- Outdated tool versions must be **locked out** ("they shouldn't be allowed to
  use out of date versions at all, even if they have to stop for 5 min").
- Alerts when a tool instance starts up and when an outdated version is seen.

## Work packages

Full implementation spec with file:line targets lives in the session scratchpad
(`fv-hardening-spec.md`); summary:

### Field tool (this repo, `frontend/` + `deploy/`)

| # | What | Notes |
|---|------|-------|
| F1 | `getAppVersion()` reads `APP_VERSION` env first | kills `version:"unknown"` in audit/WS ack on packaged builds |
| F2 | `BUILD-PORTABLE.bat` / `BUILD-INSTALLER.bat` default `APP_VERSION` from `frontend/package.json` | replaces stale hardcoded defaults (1.0.0 / 2.39.7) |
| F3 | Audit `/api/l2/cell` **failure** paths (`l2.cell.fail`): 400, 404 stale-id, 500 catch, with device/column names + user | success path was already audited (`l2.cell`) |
| F4 | Client fail-loud: destructive persistent toast on save failure + on outbox **eviction** (5 failed replays); eviction also reported server-side into the recovery log | v2.43 outbox retries exist; eviction was silent console.error |
| F5 | Background FV pull 409 (pending-guard refusal) logged + audited (`l2.pull.blocked`) instead of ignored in `pullL2Scoped` | manual-pull path already surfaces it |
| F6 | `guided-task-runner` / `vfd-wizard-modal` L2 writes: check `res.ok`, surface via toast, no silent catch | |
| F7 | **Version lockout**: `lib/update/version-lock.ts` (policy fetch via existing `fetchReleaseManifest()`, persisted locally, fail-open when cloud unreachable AND no policy ever seen); Express guard 503 `version_locked` on mutating routes (allowlist: `/api/update`, `/api/health`, `/api/config`, `/api/cloud/status`, `/api/auth`, `/api/logs`); WS `HeartbeatAck.versionLock`; full-screen non-dismissible `version-locked-overlay.tsx` with "Update now" (existing `POST /api/update/install`) | queued cloud pushes still drain while locked (internal, not HTTP) |
| F8 | Tests: version-lock eval matrix, guard allow/block, l2.cell fail audit, eviction surfacing | `frontend/__tests__/`, vitest |

### Cloud (`commissioning-cloud/` — own repo, push-to-main auto-deploys!)

| # | What | Notes |
|---|------|-------|
| C1 | `tool_version_policy` singleton table: Prisma model + additive manual SQL `prisma/tool-version-policy.sql` + re-bless `schema.prisma.sha256` | repo convention: NO `prisma migrate`; apply SQL manually to live DB |
| C2 | `GET/PUT /api/admin/version-policy` (admin session, semver-validated, audited) | |
| C3 | `GET /api/releases/latest` gains `minVersion` + `lockMessage` (null-safe if table absent) | already polled by every v2.38+ tablet — the delivery channel |
| C4 | Heartbeat hardening: **valid-key heartbeat never 400s on content** (lenient `networkDevices`, slice > caps instead of reject — central boxes exceed 64 devices, which was killing every heartbeat), never NULL `version` on update, response carries policy; alerts via `createNotification`: `tool_outdated` (+ web push) and `tool_started` (startedAt change) | |
| C5 | `notification-bell` styles for the two new types | |
| C6 | Fleet-tab "Version policy" editor (min version, lock message, count of instances below min) | |
| C7 | Tests: heartbeat tolerance matrix, policy routes, alerts dedup | `tests/`, vitest, prismaFake pattern |

## Deployment runbook (when the code lands)

1. **Cloud first**: apply `prisma/tool-version-policy.sql` to `commissioning-db`
   (dockerhost 192.168.5.30) → deploy cloud (branch → review → main). Routes
   are null-safe pre-SQL, but apply SQL first anyway.
2. Verify `curl https://commissioning.autstand.com/api/releases/latest` shows
   `minVersion: null` and heartbeats stop 400ing (fleet view starts showing
   real versions/last-seen).
3. **Field release**: bump `frontend/package.json`, build installer, drop exe in
   cloud `public/downloads/` (existing release flow in README).
4. Push updates to the fleet from the fleet tab (existing one-click update).
5. **Only then** set the minimum version in the fleet-tab policy editor —
   anything older locks out with the update screen. Watch for `tool_outdated`
   bell alerts on stragglers.

## Also fixed/known along the way

- Field heartbeat sender never logged the 400 response body — Zod details were
  invisible. (Fix rides F-package.)
- Peter Scott's 9 wiped TPE notes: intact on cloud, restored on next FV pull at
  ≥ v2.43.0. Nothing by Santiago Martinez was wiped; his 07-11 ENC checks were
  never persisted anywhere (the 114 rejected saves) and must be re-entered.
- Open review item: MCM04 `PS8_11_EPC1` Estop/Red Beacon values swapped local vs
  cloud (dian, 07-10) — needs human confirmation which side is truth.

## Implementation notes (2026-07-12, this machine)

- Field: `lib/update/version-lock.ts` (policy+guard), `lib/update/install-launcher.ts`
  (pipeline shared by the cloud `update` command and the lock overlay's
  "Update now" — `/api/update/install` is enabled ONLY while locked),
  `components/version-locked-overlay.tsx` (polls `/api/update/status`, which now
  carries `versionLock`; WS HeartbeatAck relays it as a `version-lock-changed`
  window event). New audit types: `l2.cell.fail`, `l2.outbox.evict`
  (+ `POST /api/l2/outbox-evicted`), `l2.pull.blocked`. Outbox replay eviction
  now counts ONLY permanent 4xx strikes — 503/network never evict.
- Cloud: `lib/heartbeat-sanitize.ts` replaces the strict heartbeat Zod schema
  (slice/coerce, never 400 on content; networkDevices cap 64→256 sliced);
  heartbeat never NULLs a stored version and returns `versionPolicy`; alerts
  `tool_started` (startedAt in title → per-boot alert) and `tool_outdated`
  (push only when freshly created, not on dedup). Policy editor panel lives in
  `tool-instances-viewer.tsx` above the grid.
- schema.prisma.sha256 re-blessed for the ToolVersionPolicy model.

## Resume pointers

- Uncommitted implementation: `git status` in this repo and in
  `commissioning-cloud/` (both trees intentionally left dirty until review).
  ⚠️ The 2026-07-12 forensics box's uncommitted tree was LOST — that is why the
  implementation was redone on the dev machine. Review + commit promptly.
- Forensic artifacts: `mcm04/` (box dump), session scratchpad
  `mcm11_restore_manifest.json`, `wipe-manifest-sid47.json`,
  `restore-mcm11-fv-cloud.js` (dry-run-by-default cloud restore, not needed —
  cloud already has the values).
