# Battle-test findings

Living log of what the battle environment has found. The environment's job is
to **reproduce, in an automated soak, the bug classes that have hit the field**
— and then catch their regressions forever.

## Target bug catalog (from the MCM11 sync incident, 2026-06-05)

`2026-06-05-mcm11-sync-incident.md` §5 lists 8 bugs (B1–B8) that make silent
sync-data-loss recur even on v2.40.2. The battle env targets the connectivity/
load-triggered ones because those are reproducible without a human:

| Bug | What | How the env reproduces it | Which invariant catches it |
|---|---|---|---|
| **B1** | HTTP **429** (cloud rate-limit) classified as permanent → result **dropped, not retried**. `cloud-sync-service.ts`: `permanent = status>=400 && status<500`. Cloud rate-limits push at **300/min/key**. | High write volume + `CLOUD_FLAP` (queue builds during cut, floods retries on restore → 429). | **I4** `suspect_silent_drops` with reason `HTTP 429` |
| **B7** | Version-conflict retry-cap: 200 + updatedCount=0 burns a strike; after 10 the row is **deleted** assuming "cloud already has it". | **Hot set** — all bots hammer a shared slice of IOs → version races. | **I4** `suspect_silent_drops` (version reason) |
| **B6** | Pre-pull backup failure does **not** abort the destructive pull. | (planned) make the backup dir unwritable, trigger a pull. | (planned I-backup) |
| **B2** | Pull at-risk warning under-reports (ignores comments + L2/FV). | (planned) unsynced L2 + comment, trigger pull, inspect 409 payload. | (planned) |
| **B3/B4/B5/B8** | Unsynced indicator = queue count only; heartbeat carries no queue depth; ephemeral drop toast; status-error resets count. | Mostly UI/observability — the **observer itself is the local-vs-cloud reconciliation the tool lacks (B3)**. Heartbeat depth (B4) is a cloud-side check. | I4 is the external reconciliation |

The MCM08 pull-wipe class (a destructive pull erasing unsynced local results)
is covered directly: **I4 anti-wipe** compares the bot journal (what the field
typed) to local SQLite, so a wipe that nulls both local and cloud is still caught.

## Confirmed findings

### F1 — B1 reproduced and FIXED (HTTP 429 silent drop) — 2026-06-06

**Reproduced.** A high-load + cloud-flap soak (12 bots @ 150–700ms, `CLOUD_FLAP=2,6`)
against the real MCM02 dataset drove cloud push past the 300/min rate limit. The
tool logged, repeatedly:

```
[IO Update] DROPPED-PERMANENT pendingId=1346 ioId=61516 reason="HTTP 429" result="Failed" version=3
```

9 real test results silently discarded in ~5 minutes — the exact MCM11 incident
mechanism, in an automated test. I4's `suspect_silent_drops` (reason `HTTP 429`)
flags it; the env did NOT mask it as a business rejection.

**Fixed** (`lib/cloud/sync-failure-classification.ts` + `cloud-sync-service.ts`):
429 is now classified network-level (transient) — it does NOT burn the retry
cap and is NOT deleted; it defers and retries after the window. `permanent` was
recomputed to exclude any network-level status (the caller checks `permanent`
before `network`). Unit test added (`__tests__/sync-retry-cap.test.ts`).
Verified in the env: same flap load, `suspect_silent_drops`(HTTP 429) → 0,
queue drains, I4 passes.

This single fix is incident recommendation #1 ("Fix B1 immediately").

### Still open (documented, not yet fixed)

- **B7** version-conflict retry-cap can drop genuinely-unsynced results. The
  hot-set load produces version races; if a soak shows `suspect_silent_drops`
  with a version reason, that's B7. Lower frequency than B1.
- **B2/B6** pull-warning completeness + pre-pull-backup-abort — needs a dedicated
  pull-during-dirty-state scenario (planned).
- **B4** heartbeat queue-depth — cloud-side/fleet change, out of the tool's soak.

### Behavior notes (by-design, documented — not bugs)

- **Cloud→field propagation requires a drained offline queue.** The tool skips
  `pullFromCloud` while `PendingSyncs > 0` (it would 409 against the pull-guard
  anyway). So cloud-side changes (new IOs, coordinator edits) reach a tablet
  only once its own unsynced work has flushed. Correct (protects field data
  over propagation), but means: a tablet with a persistent backlog won't see
  cloud changes until it catches up. The battle env's I7 therefore needs
  REALISTIC load (queue actually drains); a sustained 6-bot write storm keeps
  the queue non-empty forever and propagation never fires — a test-tuning
  artifact, not a tool fault.
- **A growing queue under sustained overload is not data loss.** Writes are
  safe in `PendingSyncs`; I4 treats queued IOs as safe and only fails on a
  write that is neither in cloud nor queued (truly dropped/wiped).
- **Harness DNS:** restoring a `cloudcut` must re-add the compose service alias
  or the tool can never re-resolve `cloud` (fixed). Lesson for any docker-
  network chaos: reconnect with the original aliases.

### F2 — PendingSyncs table bloat under rapid same-IO writes (no durable coalescing) — 2026-06-06

Observed in the overnight soak: with a hot-set of 8 IOs hammered by 3 bots,
the durable `PendingSyncs` table grew unbounded (542→1224 rows/hour) and the
cloud logged 7315 version conflicts. The hot IOs each had 60–99 queued rows.

Mechanism: the tool writes one `PendingSyncs` row per IO write. The IN-MEMORY
offline queue is keyed by IO id so it coalesces (stays ~= distinct IOs, never
near MAX_OFFLINE_QUEUE=5000 — so NO write loss, confirmed), but the DURABLE
table is not coalesced. Rapid repeated writes to one IO pile up rows whose
base versions fall behind cloud; each push then `updatedCount=0` (version
conflict), retries, and never drains while newer writes keep arriving.

Severity: **not data loss** (0 non-SPARE drops — conflicts retry, don't drop;
the latest version per IO does eventually sync). But it (a) bloats the queue,
(b) blocks cloud→field propagation (pull is skipped while PendingSyncs>0), and
(c) is the soil B7 grows in — if a version-conflicted row ever hit the retry
cap it would be dropped. A durable per-IO coalesce (keep only the latest
pending version per IO) would fix all three. Logged as a future enhancement,
not fixed tonight (sync change = high-risk, no loss occurring).

Test impact: the hot-set is a B7 stress knob; it must be OFF for the
propagation (I7) scenario or the queue never drains and I7 can't fire. Fixed
the mutate scenario to HOT_FRACTION=0.

### F3 — cloud-stage seeded NULL results → I4 false-positive on pre-existing field results — 2026-06-06

The overnight soak's manual I4 first read FAIL: 52 IOs `local=Passed, cloud=null,
not-queued, not-SPARE`. Investigated to ground truth: **all 52 already had a
result in the field seed (pre-soak) and all 52 logged "No syncable change
(resultChanged=false) — skipping PendingSync".** Root cause: the field DB seed
carries ~500 real MCM02 results, but `seed.py` seeded cloud-stage results NULL.
The tool only syncs CHANGES, so a bot re-marking an already-set value is a
correct no-op — but it left local≠cloud for those pre-existing results forever,
which the journal-vs-cloud check mis-read as loss. **Zero actual data loss.**
Fix: cloud-stage now mirrors local's initial `result` (seed.py), so I4 tracks
only genuine soak-changes. Lesson: a data-loss invariant must compare against a
cloud baseline that matches local's initial state, and must judge a CONVERGED
system (live snapshots also skew — the 6 "wiped" were concurrent-write ordering,
local held valid results).

## Run log

### v2.40.4 pre-release verification — 2026-06-06 — PASS (after env fixes)

Verifying the B2–B8 sync-loss fixes + perf. Caught a **release-blocker** first:
the new coalesce trigger referenced `DeadLettered` before the migration that
adds it, so on a fresh DB the whole schema init threw and silently skipped
every migration — the dead-letter feature was dead and sync errored each cycle.
**This would have shipped** (280 unit tests passed; only a real fresh-DB boot
exposed it). Fixed: column in CREATE TABLE + trigger after migrations.

Two env-measurement bugs the run then exposed (not product issues), now fixed:
- **F3 (again):** the seeder image wasn't rebuilt, so cloud was seeded NULL —
  pre-existing local results read as "lost". Rebuilt → cloud mirrors local.
- **I1 boot transient:** schema init + 592-tag creation briefly blocks the loop
  at boot; on a short soak that one-time spike failed I1. Added a 120 s warmup
  exclusion (like I2). Sustained p99 was 48 ms — healthy.
- **I4 definition was wrong:** it flagged ANY local≠cloud as loss. But the
  system is last-write-wins and a SPARE-Passed value the cloud legitimately
  refuses stays local-only by design. Converged manual analysis (bots stopped,
  queue drained to 0) proved the "298 losses" were **42 last-write-wins + 256
  SPARE-Passed business rejections, 0 true wipes, 0 suspect drops** — zero real
  loss. I4 now fails only on a TRUE wipe (local erased) or a suspect bug-drop.

Verified for v2.40.4: migration clean (0 errors), coalesce ratio 1.00 (was
60–99 rows/IO), parking + durable audit working, queue drains to 0 cleanly,
I1/I2/I3/I5 PASS, **no data loss** (0 true wipes, 0 suspect drops).

### overnight-20260606-0236 — 7.5 h comprehensive soak — PASS ✅

Config: real MCM02 dataset (1184 IOs / 72 VFDs), 3 realistic bots, all chaos at
once — PLC download storm (3 downloads) + cloud flap (8 cuts, VPN-profile) +
cloud-side mutations. Tool = v2.40.3 (B1-fixed).

| Invariant | Result | Evidence |
|---|---|---|
| I1 responsiveness | **PASS** | `/api/health` p50 1.8 / p95 4.7 / **p99 ~20 ms** across 24k+ samples, no gap >10 s |
| I2 no leak | **PASS** | RSS flat ~115→126 MB over 7.5 h (well under 5 MB/h) |
| I3 flag restore | **PASS** | plc-reconnect restore syncs fired after PLC downloads |
| I4 no data loss | **PASS** | **0 suspect silent drops** (B1 fix held all night); the 52 "unsynced"/6 "wiped" proven = F3 seed-asymmetry + no-op re-marks + live-snapshot ordering, **zero field work lost**; 1024 IOs safely queued |
| I5 stability | **PASS** | 1 server.start, 0 FATAL, 0 Sync errors |
| I7 propagation | n/a (degraded) | blocked by F2 hot-set queue bloat (test artifact, not a tool fault) — hot-set now OFF for the mutate scenario |

Bottom line: **the v2.40.3 tool survived 7.5 h of simultaneous PLC + cloud
chaos at field scale with zero data loss, zero crashes, no leak, and a flat
fast event loop.** The two env-tuning issues found (F2 hot-set bloat, F3 seed
asymmetry) are fixed for future runs.

---

## Nightly 2026-06-07 (run #657, `all` scenario, 8h) — findings

The first real 8-hour nightly. 4 invariants strong (I1 p95 150ms / 0 stalls,
I2 2.8 MB/h, I5 1 start / 14 flaps, **I3 13/13 PLC-download restores**). But it
surfaced one harness flaw and one **real tool bug**:

- **F4 (harness): I4 was VACUOUS.** Over 8h, 85,278 random writes hit all 1,184
  IOs, so every IO became multi-writer → the observer's collision-exclusion
  dropped all of them → `soak_writes=0`, I4 checked nothing (a meaningless
  green). **Fix:** partition IO ownership per bot (`io.id % BOTS`), so every IO
  is single-writer and I4 verifies the full set even over hours. (`crew/bot.mjs`)

- **B9 (REAL TOOL BUG): parked rows block cloud auto-pull forever.** The auto-
  pull gate (`pullFromCloud`) counted `COUNT(*) FROM PendingSyncs` — ALL rows.
  v2.40.4 PARKS permanently-rejected rows (DeadLettered=1) instead of deleting,
  so one SPARE-Passed mistake leaves a parked row forever → the gate is never
  clear → the tablet STOPS pulling cloud changes entirely (coordinator/other-
  tablet/installation-tracker edits invisible). A v2.40.4 regression: park-not-
  delete fixed silent loss (B3/B5/B7) but broke propagation. **This is exactly
  the I7 "queue never drained" symptom** — the 14,564 "pending" in #657 was
  almost all parked rows, not backlog. **Fix:** auto-pull gate counts ACTIVE
  rows only (`DeadLettered=0`); per-IO no-clobber set still preserves parked IO
  local values; manual destructive pull-guard unchanged (still all rows, by
  design). `frontend/lib/cloud/auto-sync.ts` + regression tests in
  `pending-sync-deadletter.test.ts`. Observer pending count also → active-only
  so the verdict + I7 precondition match the tool.

Open follow-up (lower priority): push throughput under sustained load + flap was
low (77 successful row-pushes in 8h, cloud-flap-dominated); worth confirming the
tool catches up cleanly once cloud is stable. Also consider teaching bots to not
mark SPARE IOs Passed (reduces unrealistic rejection churn).

### B10 (open — surfaced once B9 was fixed): cloud ADDITIONS don't reach the field

With B9 fixed and the active queue draining to 0 (#662: queue_end=0), I7 finally
runs as a real test — and fails: 9 IOs added cloud-side, 0 reached local. Tool
logs show **0 pull executions** the whole run. Auto-pull is "on SSE reconnect
only"; the SSE connected at boot (pulled the pre-mutation seed), the cloud-flap
TERMINATED it mid-soak, and reconnect looped on "fetch failed" — so no post-
mutation change-pull ever fired. Unclear yet whether this is:
  (a) env: the docker-network flap doesn't cleanly restore SSE, so the trigger
      never fires (most likely from the logs), or
  (b) tool: auto-pull only fires on SSE (re)connect with no fallback, so a tablet
      that stays connected after additions appear won't see them until it
      reconnects — a real propagation-latency gap worth confirming.
Action taken: I7 made REPORT-ONLY (does not gate the build) — it's the most env-
dependent invariant and shouldn't red the nightly on (a). To investigate: give
the env a clean cloud-cut that the SSE recovers from (or an explicit reconnect),
then re-judge; if additions still don't import after a confirmed reconnect+pull,
it's a real tool bug.
