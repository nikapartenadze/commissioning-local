# Handover — belt-tracking sync + PLC retract (2026-07-23)

Consolidated record of a long session across `commissioning-cloud` and
`commissioning-local`. Everything below is merged to `main` and pushed unless
stated otherwise.

## LATEST: local tool v2.49.0 — Fast, non-blocking Compare (main @ 4782e25, released)

Follows v2.48.0. Research-grounded rebuild of "Compare with cloud" (outbox +
version manifest + targeted fetch + optimistic per-row UI — Fraser/Dynamo/
Replicache/TanStack practice, fitted to our version/cursor/heartbeat machinery).
- **Cloud (deployed, f22ecf3):** two cheap endpoints —
  `GET /api/sync/subsystem/[id]/versions` (id→version manifest, no payloads) and
  `POST /api/sync/subsystem/[id]/rows` (full values for only the divergent ids).
  `testedBy` comes from the newest history row per id (targeted), since it's not
  an `ios` column — NOT a whole-history dump. IO only.
- **Tool:** Compare reads the outbox (local-ahead) + the manifest, fetches values
  only for divergent rows — O(divergent), zero testHistories (was O(all)+all
  histories = minutes). Compares against **base_version** so an optimistic local
  edit is "push", never misread as "cloud newer, discard the tech's result".
  Completeness kept: a local IO absent from the manifest surfaces even with 0 in
  the queue (the orphan / "0 queued but still stuck" case).
- **UX:** global `busy` lock deleted → per-row optimistic removal, rollback+Retry
  on failure, no full re-diff after an action. Panel never freezes.
- **Cloud freshness:** a heartbeat fires after each Compare action, so the fleet
  stuck-count updates in ~1s, not ~10s.
- 1438 tests; both tsc + vite build clean. Requires cloud ≥ f22ecf3 (deployed).

**Scope:** IO Compare only. **L2/FV Compare is a follow-up** — the cloud L2
change-log is section-level (no per-cell ids) and `L2Device` has no subsystem FK,
so a correct L2 manifest needs new cloud work; not bolted on here.

**Unrelated pre-existing failing test (NOT this work, do not treat as a
regression):** `commissioning-cloud tests/sync-health.test.ts > "a viewer on a
healthy project still gets green"` returns amber. Cause: another session's commit
`0bd8169` ("trust the tool's itemized queue, not its stale aggregate counters")
made green require itemized queue evidence; the test fixture reports only
aggregate `pending:0` with `systemInfo:null`, so it correctly reads amber now.
The behaviour is more honest; the fixture/expectation is stale. It shipped
already (0bd8169 is deployed) so CI doesn't gate on it. Owner of 0bd8169 should
update the fixture (add itemized queue evidence) or the expectation.

## local tool v2.48.0 — Honest Sync Center (main @ 329096a, released)

Follows v2.47.0. Fixes the Sync Center reassuring when it should alarm — a tablet
that couldn't reach the cloud showed rows as "Sending… temporary… nothing to do"
for 24h, the Compare tab spun forever, and Retry only reset a flag.
- **Connection-health banner** at the top: measured reachable / can't-reach /
  wrong-key(403) / server-error / unknown, + a "Test connection" probe. Reuses
  the SSE `auth-failed` signal and the heartbeat HTTP status that was being
  computed every 10s and discarded. Never green on failure or from absence.
- **Rows stop lying**: failing >15 min → "not reaching the cloud, check
  connection"; 401/403 → "this tablet's key is wrong, fix it, data safe".
- **Real bug fixed**: 403 was classified `gone_on_cloud` = "removed, safe to
  discard" — a path to discarding auth-blocked data. Now `auth_error`.
- **Retry actually pushes** (via the force-sync `kickPush` entrypoint) and
  reports the true outcome; **Compare times out** at 15s.
- Verdict logic extracted to a **client-safe `lib/sync/queue-display.ts`**
  imported by both the tablet page and the lib — no hand-mirror drift, and no
  better-sqlite3 in the browser bundle (verified by `vite build`, the only gate
  that catches that leak; tsc/vitest do not).
- 1416 tests; both tsc builds + vite build clean.

**Operational note the v2.48 banner will make obvious:** a tablet stuck
"Sending" for hours is almost always a wrong cloud API key (HTTP 403) or a lost
connection — check the tablet's `apiPassword` vs the project key, and its
network to `commissioning.autstand.com`.

## The problem this solved

Mechanics untrack belts on the cloud belt-tracking page. That was not reaching
the field tablets, so tablets kept asserting `Tracking_Finished` into the shared
MCM controllers — which takes belt-direction control away from the keypad. On
2026-07-22 this cost ~4 hours: belts untracked at 12:37 were still latched at
16:30, mechanics could not reverse them, and the only fix was remoting into every
tool instance by hand. Multiple instances run one MCM (MCM15 had 3 connected,
two sharing the hostname "autstand"), so clearing one never held.

## What shipped

### Cloud — deployed to prod (`origin/main` @ `509dfb1`, healthy)
My belt-tracking commits (`5a59365`, `035a1aa`, `bf1166f`, `aeb542a`) are all
preserved; another session added `509dfb1` (sync-health banner in the header
toolbar) on top. Contents:
- Machine-readable rejection codes on `/api/sync/update`.
- Queue/held-back telemetry ingest; project freshness badge (Coordinator+ only).
- `sync_error` notification now actually emitted.
- MCM-ownership admin view (which instances own each controller; multi-claim +
  hostname-collision flagged).
- Belt-tracking toggle keyed on **mcm** (not the free-text subsystem label), and
  an honest "not sent to the field" warning when a toggle can't propagate.

### Local tool — released as **v2.47.0** (`main` @ `ce9fe3a`, GitHub release + installer)
- **Cloud untrack syncs down** and clears the tablet's `Belt Tracked` cell
  (pull + SSE), and the reconciler no longer re-uploads "Yes" (`cb92781`).
- **Writer stops asserting** post-gate flags when a belt isn't tracked, and
  **retracts the PLC latch** on the tracked→untracked edge:
  `Normal_Polarity → Invalidate_Direction → Invalidate_Tracking_Finished`,
  deferred while the belt is running (`948c70e`).
- **Local keypad control restored** — re-pulses `Valid_Map`/`Valid_HP` on an
  untracked belt, level-based, never `Invalidate_HP` (`2d47185`).
- **Wizard falls back** instead of re-latching when a belt is untracked
  (`9d9a826`).
- **Clear Test fixed** — no longer sends `Invalidate_HP` first, which used to
  strand the latch and kill the keypad (`e5e641b`).
- **Server-side gate** — `write-tag`/`write-tags-batch` refuse post-gate writes
  on an untracked belt (`6241f6f`, `ce9fe3a`).
- Per-subsystem belt-tracking telemetry in the heartbeat (`3519c51`).
- Cross-process E2E test (real cloud + sync + writer + gate; auto-skips without
  a cloud).

## Verification done

- **1345 automated tests** pass on local `main`; cloud suite green.
- **Cross-process software E2E** (all 8 steps green): real cloud process, real
  HTTP untrack, real pull, real writer, real gate — only the PLC leaf faked.
  Run: `commissioning-local`, bring up `local-cloud.compose.yml`, then
  `frontend/__tests__/e2e-belt-untrack-live.test.ts`.
- **Real-controller write path** (192.168.20.40 path 1,0, MCM02): the tool's CIP
  writes land and are ACK'd.

## NOT verified — needs you, and why

**The live PLC latch behaviour could not be proven**, because the belt-tracking
AOI is **not reliably scanning** on the staging controller. Measured directly:
`CMD.Valid_Map` written = 1 persists for 800ms+ (rung 8 `FLL` not clearing it) ⇒
the AOI logic isn't executing. When you saw "boom everything works", it *was*
scanning; later it wasn't. Also `UL21_2_VFD:I.ConnectionFaulted = 1` (real fault)
— but that's moot while the AOI isn't scanned. `Tracking_Finished` is a LocalTag
(`ExternalAccess=None`) so it's unreadable regardless; the readable proxy is
`STS.Valid_Direction` (latches only if `Tracking_Finished` was set).

To finish the live-hardware check: get the controller in **Run with the
belt-tracking routine scheduled/scanning**, force `Check_Allowed` (a Studio 5000
force — a module `:I` input can't be set via CIP), then drive the loop. Optional
AOI improvement: add `XIC(Tracking_Finished) OTE(CTRL.STS.Tracking_Finished)` to
rung 9 + the STS member, making the latch readable and this fully closed-loop.

## Dev environment (for the live check)

- `local-cloud.compose.yml` → cloud at http://localhost:13001 (image
  `battle/cloud:local` already built). Seed MCM02/CDW5 as before.
- `start-dev-e2e.ps1` sets `CLOUD_URL_OVERRIDE` (mandatory — without it the tool
  syncs to PROD) and runs `npm run dev` → tool UI http://localhost:5173.
- See `E2E-DEV-WALKTHROUGH.md` for the click-through.
- Gotcha: port 3020 is held by an unrelated tool instance ("MCM40 Test") — stop
  it or the MCM02 dev server won't bind.

## Outstanding

1. **Install v2.47.0 on the 3 MCM15 tablets** — they're on 2.45.0, none of this
   reaches the field until they update. That is what ends the recurrence.
2. **22 bad L2 data rows** (13 SYS-sheet with device_name/mcm swapped, 9 with no
   mcm) — the new "not sent to field" banner will nag until fixed.
3. **No auth** on the four PLC-write routes (`write-tag`, `write-tags-batch`,
   `clear`, `test-write`) — the gate blocks belt bits but the routes are open.
4. **Live-hardware latch check** — pending the controller scanning (above).

## Field cleanup already applied (DB)

BYBD_1-4 restored then re-untracked on cloud; 16 Admin-attributed untrack cells
re-attributed to the real field actors (Camron Graham, AJ, Arick, Darwin) — no
"Admin"/"AI"/"API" left in `l2_cell_values`. Belts left as their true state.
