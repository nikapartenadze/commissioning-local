# Battle-test findings

Living log of what the battle environment has found. The environment's job is
to **reproduce, in an automated soak, the bug classes that have hit the field**
— and then catch their regressions forever.

## Coverage build-out + v2.42.11 baseline (2026-07-06)

**Context.** The nightlies (#1180/1182/1184) had been PULLING an 8-day-stale
`tool` image and a 4-day-stale `cloud` image — they never tested the v2.42.11
sync-hardening fixes. #1182 failed **I5 stability** (cloud-connection-error flap
storm; the cloud tipped over with a Prisma /api/health error under sustained
chaos; 11,451 parked L2 rows). Rebuilt both images from current `main`
(a4f7002 / v2.42.11) locally and re-ran.

**Coverage added (this build-out):**
- **Feature bots** (`crew/bot.mjs`): beyond IO + FV, bots now drive e-stop EPC
  checks, guided task complete/skip, punchlist, dependencies, and VFD bump
  blockers — each partitioned single-writer + journaled per type. New env
  fractions `ESTOP/GUIDED/PUNCH/DEPS/BLOCKER_FRACTION`; new `features` scenario.
- **Per-type survival gates** (`observer/probe.py`): I22 e-stop, I23 guided,
  I24 blocker, I25 punchlist/deps — journal→local, mirroring I18. REPORT-ONLY.
- **Resource/log invariants:** I19 log-growth, I20 FD/handle-leak (chaos samples
  `/proc/1/fd` via a docker-exec `resource_sampler`), I21 sync-latency. REPORT-ONLY.

**v2.42.11 baseline verdict (`all`, 45 min, single-MCM, dev laptop):**
PASS on every data/stability invariant; FAIL only on **I1 responsiveness**.
- I4 no-data-loss ✅ (489 writes, 0 wipes, 0 silent drops), I18 FV ✅ (1029
  writes, 0 mismatches), I5 stability ✅ (1 flap — vs #1182's storm), I2/I20 no
  leak (FD 31→150→31), I19 logs 3.8 MB bounded, I8/I9/I10 ✅.
- **I1 FAIL:** p50 3.8 ms but p95 690 ms, p99 4.6 s, max 9 s, 2 gaps >10 s.
  Root cause in tool logs: `SLOW PUT /api/ios/... → 200 (5–8 s)`. The single Node
  event loop + **synchronous better-sqlite3 writes + on-request sync-push** stall
  multi-second under heavy concurrent load (6 aggressive bots + FV + hot + all
  chaos). NOT data loss (writes still land). Correlates with I21 tail (p99 5.3 s).
- Throughput: 243 IO pending + **1,692 L2 cells parked** (retry-cap) at soak end
  under sustained cloud flap — safe + surfaced (I18 green), not synced until
  reconnect/unpark. The cloud-capacity / backpressure signal.

**Architectural implications (for the deployment decision):**
1. Move the immediate cloud-push + heavy SQLite work OFF the request path
   (fire-and-forget enqueue / batched writes / worker) — the deferred
   "async-write" tech-debt item; the soak now proves it bites under load.
2. Sync throughput under degraded links + the retry-cap-on-conflict parking
   behavior; and the cloud single-container capacity (dedicated throughput
   scenario pending) — informs the multi-container question.

**Caveat:** dev-laptop Docker + 6 bots is far more concurrent than real field
use; absolute latencies inflated, the relative event-loop finding is real.

**210-min CERTIFICATION soak (`all` + full features, v2.42.11) — the long-window verdict:**
PASS on everything except a single I1 stall. The leak/growth gates are now
CONCLUSIVE (148-min window, not inconclusive):
- I2 memory PASS — RSS slope **4.1 MB/h** (< 5 bar), gated. No leak.
- I20 FD PASS — fd 31→514→**32**, slope **1.7/h**, reliable. No handle/tag leak
  (returns to baseline — the "lag after hours" fear disproven).
- I19 logs PASS — 17.4 MB / 3.5 h, bounded.
- Data safety ALL green: I4 (416, 0 wipes/drops), I18 FV (4179, 0), I22 e-stop
  (32, 0), I23 guided (48, 0), **I25 punchlist/deps (485+743, 0** — the false-
  positive fix works). I24 blocker still vacuous (bot action not firing —
  remaining coverage nit).
- I1 FAIL: p95 54 ms / p99 627 ms (both fine) but **1 gap >10 s** (one ~9 s stall
  in 3.5 h) trips the zero-gap rule — the rare event-loop stall, same class.
- Throughput: ended 1128 IO + **5460 FV cells parked** under 3.5 h sustained
  flap — safe/surfaced (I18 green), drains on reconnect. Cloud-capacity signal.
Verdict archived: `battle/cert-210min-verdict.json`. Full write-up +
architecture recommendation: `docs/superpowers/plans/2026-07-06-field-tool-
hardening-verdict.md`.

**HARNESS LESSON:** never edit `ci/run_scenario.sh` while a soak is running it —
a live `sh` re-reads the file and shifted bytes corrupt it (broke the baseline's
artifact export; verdict recovered from the `battle_runs` volume). Edit the
driver only between runs.

## crud-propagation scenario + I14-I17 authored (2026-06-27) — REPORT-ONLY, PENDING first soak

Closes the live cloud→field propagation gap for the four data types the field
**pulls** (not the result path): VFD **ADDRESSED** blocker, **L2/FV** cell,
**e-stop** zone tree, **network** ring/port (TEST-COVERAGE.md Part 4). Authored
**on a machine with no Docker — NOT yet run.** All four invariants are
**REPORT-ONLY** (recorded in `verdict.json`, never gate) until proven green ×2 on
a real soak (skill rule #4).

- `battle/ci/run_scenario.sh` — new `crud-propagation` case: `MUTATE_MODE=crud`,
  `COMPOSE_PROFILES=mutate`, `HOT_FRACTION=0` (drained queue so the scoped pull
  fires), light cloud flap, 4 bots. Modeled on `mutate`/`delta`.
- `battle/cloud-mutator/mutate.sh` — new `crud_loop`: raw-psql edits keyed to the
  seeder's per-MCM CRUD rows (mark blocker ADDRESSED; bump an L2 cell
  value+version strictly newer than seed v1; rename an e-stop zone; rename a
  network ring + port). Per-kind `mode:"crud"` journal lines so the observer
  knows the exact value/version to expect.
- `battle/seeder/seed.py` — new `gen_crud_seed`: distinct per-MCM cloud-stage rows
  (Device+VfdCommissioningBlocker, L2 template/sheet/column/device/cell, e-stop
  zone→epc, network ring→node→port) at fixed ids `9_000_000 + subsystemId`.
- `battle/observer/probe.py` — `check_i14..check_i17`, mirroring the I11/I12
  mechanism (parse journal → POST the tool's real local pull endpoint → poll the
  tool's local SQLite → compare). I15 includes the LWW-older-echo observation
  (full e2e older-echo needs the SSE path — see note). I16/I17 snapshot OTHER
  MCMs' zone/ring counts before/after to catch a cross-MCM wipe (the legacy
  `pull-estop` does a GLOBAL `DELETE FROM EStopZones`).

Syntax-checked clean (`py_compile` ×2, `sh -n` ×2). **TODO-verify-on-soak:**
(1) cloud-stage Postgres column lists/NOT-NULL for the 6 seeded tables are taken
from the cloud Prisma schema, not run — a drift surfaces as a psql error in the
seeder log; (2) the four field pull endpoints are driven by the observer over
HTTP (SQL-mode edits fire no SSE hint) — confirm they exist + accept these
bodies; (3) I16/I17 cross-MCM wipe is only observable on a MULTI-MCM run (single
MCM → vacuously []); (4) I15's older-echo negative case is contract-observed
here, fully exercised by the `l2-fv-sync-coverage.test.ts` unit test.

## Orphan-result reconciler + backup-churn fix (2026-06-22) — code done, battle scenario PENDING image rebuild

**Problem (field report).** After a long offline stint / flapping link, operators
hit: Cloud-Sync modal shows **0 pending**, yet **Pull keeps warning** that specific
results would be overwritten, and it **never clears**. Root cause: a result that
left the `PendingSyncs` queue WITHOUT landing on cloud (legacy retry-cap *delete*,
permanent-reject *delete*) becomes an **orphan** — present in local `Ios`, absent on
cloud, with NO queue row. The push loop only drains the queue, so nothing ever
re-pushes it; only the destructive-pull guard surfaces it (as a block, with the
push button disabled at queue=0). This is the MCM08/MCM11 residue class.

**Fix (frontend/, code complete, 455/455 unit tests green incl. 8 new):**
- `lib/cloud/result-reconciler.ts` — runs the pull-guard diff and **re-enqueues**
  any local result/comment the cloud is missing but that has no queue row, at the
  cloud's current version (B7 rebases any miss). Skips IOs with any existing queue
  row (active or parked); never touches `Ios`; best-effort on cloud failure.
- `lib/cloud/auto-sync.ts` — runs it (throttled 2 min) **on SSE reconnect** and the
  15-min safety tick → orphans self-heal on the next "net came back".
- `POST /api/cloud/reconcile` — on-demand force (and the battle hook).
- Backup churn: `app/api/mcm/[id]/pull/route.ts` now takes the pre-pull backup
  AFTER the at-risk guard and **skips it for background catch-up pulls** with
  nothing to recover (the every-few-minutes full-DB copy storm); retention 300→100.
  Auto-sync catch-up pulls send `{ background: true }`.

**Battle verification — TODO once the tool image is rebuilt+pushed** (CI pulls the
image, so this can only run after `ci/build_and_push.sh`; no local Docker on the
dev box this was authored on). Add scenario **`s8` (orphan recovery)** + invariant
**`I8`**:
- chaos `/orphan`: mid-soak, for K IOs that have a *journaled local result the
  cloud lacks*, DELETE their active `PendingSyncs` row (simulating the historical
  drop) — creating a true queue-less orphan without nulling the local result.
- under `CLOUD_FLAP` so reconnects fire the reconciler.
- **I8 (GATE):** at quiescent soak-end, every orphaned IO's result is present on
  cloud (`reconciled`), and `suspect_silent_drops` stays 0. A clean run (no
  `/orphan`) must be vacuously green. Per the skill: run twice, confirm green,
  before trusting the gate.
This closes the loop the existing `s3`/I4 leaves open: I4 proves the queue isn't
*dropped* under flap; I8 proves a *queue-less orphan is recovered*.

## REAL polarity/Valid_* WRITE-BACK proof (2026-06-08) — MCM02 @ 192.168.20.40 path 1,1 ✅

The .5.x bench emulators lacked the belt-tracking AOI CMD tags, so the write
path couldn't be exercised there. A second controller at **192.168.20.40
(path `1,1`, NOT the `0,1` first given — path sweep found the CPU at
backplane/slot 1,1)** runs the full MCM02 program WITH the belt-tracking AOI.

- Connect: **1184/1184 tags (100%)** — full MCM02 program on real CIP.
- Validation writer (split, via the gateway typed-batch path):
  `Sync done (mcm-38-reconnect): 72 devices, 282 written, 69 already-correct,
  0 failed, 2982 ms` — 282 CMD.Valid_*/polarity writes ACK'd OK on real CIP.
- **Direct write→read-back round trip** (definitive): `CBT_UL21_3_VFD.CTRL.CMD.
  Valid_Map` before=0 → write OK → **after=1**; restored to 0. Same for
  `Invalidate_Map`. **The tool writes tag values back to the real controller
  and they land.**
- `CTRL.STS.Valid_*` stayed 0: the AOI only *latches* persistent status given
  real drive-identity feedback, which an equipment-less Emulate instance can't
  provide. That's AOI/emulator behavior downstream of the write — the write
  itself is proven. On a real drive the same CMD pulse latches STS.

## REAL-hardware validation (2026-06-08) — split deployment vs live Logix Emulate — PASS ✅

`SCENARIO=central-cdw5-live`: the Phase-1.1 split stack pointed at the lab-bench
**Studio 5000 Logix Emulate** controllers (192.168.5.x, real EtherNet/IP, no
physical equipment). A read-only signature probe (`battle/_live_probe.js`,
needs `initLibrary()` first) found 4 distinct CDW5 programs loaded:
MCM01→.101, MCM03→.105, MCM05→.114, MCM09→.109. Validation against those 4:

| Invariant | Result |
|---|---|
| connect | 4/4 over real CIP. MCM01/MCM09 100% tags; MCM03 38% / MCM05 51% (these emulator builds lack devices the prod dump references — real program-revision drift, handled gracefully). |
| **I1 perf** | **PASS — p50 1.8 / p95 24.6 / p99 442 ms, 0 gaps** (one 2.3 s max spike under cloud-flap). App CPU ~18%, gateway ~182% — the split keeps the app loop instant on REAL Logix CIP. |
| **I4 loss** | **PASS — 1486 writes, 0 wipes, 0 suspect drops, 0 business rej**; 75 safely queued at end (cloud-flap backlog, draining). |
| I5 | PASS — 1 start, 0 unexpected flaps. |
| I2 | PASS — no leak. |

Confirmed on real CIP: the split deployment connects real Logix controllers,
the app event loop stays instant while the gateway carries the CIP load, and
the validation writer runs via the gateway typed-batch path (`mcm-37-reconnect`,
~100 ms, non-blocking) and handles absent CMD tags gracefully (these emulator
programs lack the `CBT_<dev>.CTRL.CMD.Valid_*`/polarity tags, so the polarity
*write* itself is only exercisable on the sim, where those tags exist —
documented limitation of this bench, not a tool gap). NO PLC-download chaos
(can't restart a real controller); the prod site PLCs live at 11.200.1.1 and
were never touched.

## Phase 1.1 SPLIT deployment — overnight verdict (2026-06-07/08) — ALL GREEN ✅

Six consecutive 1-hour `central-cdw5-split` soaks on the GitLab runner (every
2h, 18:00→04:00, schedule on the branch ref, `tool:central` image with the
B7 fix). The full 19-MCM CDW5 production-dump site, app in `PLC_MODE=remote`,
all PLC I/O owned by the plc-gateway process, under download storm + cloud flap.

| Run | I1 p50/p95/p99/max (ms) | I3 dl/restore | I4 writes/wipes/suspect | I5 |
|---|---|---|---|---|
| 688 | 3.5 / 134 / 263 / 604 · 0 gaps | 3 / 20 | 7177 / 0 / 0 | 1 start, 0 flap |
| 690 | 3.5 / 141 / 273 / 527 · 0 gaps | 3 / 12 | 7225 / 0 / 0 | 1 start, 0 flap |
| 692 | 3.4 / 119 / 239 / 522 · 0 gaps | 4 / 24 | 7126 / 0 / 0 | 1 start, 0 flap |

(687/689/691 likewise PASS.) **Every invariant green on every run.** The two
goals are proven:

1. **Performance solved by the split.** App health p95 ~130 ms / p99 ~250 ms
   under the full 19-MCM load — vs embedded `central-cdw5` p95 921 ms / p99
   1456 ms (FAIL). The app event loop is never blocked by tag I/O; the gateway
   owns it on its own cores. I1 now passes with large margin.
2. **B7 fixed and held.** `suspect_silent_drops = 0` on all runs (the pre-fix
   local split run had 389 parked rows of the `updatedCount=0` ghost class).
   The reconcile-against-cloud-truth pass (clear ghosts / clear superseded /
   rebase divergent) + the 2× cap for version-conflict rows kept the queue
   draining cleanly (53–142 safely queued at snapshot, 0 parked-as-suspect).

Also confirmed in split mode: I3 polarity/Valid_* restore fires via the
gateway→`McmReconnected`→app-writer→gateway-write-back seam after every
injected program download (12–24 restore passes/run); the safety-critical
write-back path works identically to embedded. I5 = 1 server.start (the
double-audit merge fix held), 0 unexpected flaps.

Net: the centralized server is production-grade on the split deployment —
no data loss, no leak, no stalls, polarity write-back intact, at full CDW5
scale under chaos, for six straight hours.

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

## Central (multi-MCM) round 1 — 2026-06-07, 1 h, 4 MCMs — data PASS, one merge bug caught

First soak of the CENTRALIZED tool (branch `central-tool-latest`, registry-only:
4 cloned MCM02 subsystems, one plc-sim each, 8 partitioned bots, download storm
across random sims, no cloud flap). `SCENARIO=central`.

| Invariant | Result |
|---|---|
| I1 | PASS — p50 18 ms / p95 283 / p99 539, 0 stalls. NOTE: ~60× heavier than single-MCM (p95 4.7 ms on the 7.5 h soak); 4 concurrent PlcClients cost real CPU. Scaling signal for the 19-MCM round. |
| I2 | PASS |
| I3 | PASS — 3 downloads → 4 restore passes via the NEW per-MCM `mcm-<id>-reconnect` hook; owning-PLC download restored all 209 flags in 1.05 s; non-owning downloads correctly verify-only. |
| I4 | **PASS — 4,164 single-writer writes, 0 true wipes, 0 suspect drops**, 2,047 explained SPARE rejections, queue drained to 0. |
| I5 | FAIL → **real merge bug**: `server.start` audited TWICE per boot (main and the central branch each added the audit line; the merge kept both, `server-express.ts` listen callback). Every boot read as a crash-loop. Fixed same day (removed the duplicate). |

Also found:
- **Flap-count blind spot (harness):** `plc_flaps=0` despite 3 downloads — the
  observer's `Connection status: error` regex doesn't match the registry
  clients' log lines, so the I5 flap budget is vacuous in central mode. Open.
- **Clone artifact:** cloned subsystems share device names, so the VFD writer's
  deviceName→subsystem map routes all 72 drives to ONE MCM. Harness artifact
  (real sites have unique names per MCM) — fixed by the CDW5 real-dump round.
- SPARE-Passed rejection churn ×4 (bots × clones). Reinforces the existing
  follow-up: teach bots not to mark SPARE IOs Passed.

## Central round 2 — 2026-06-07, 1 h, ALL 19 REAL CDW5 MCMs (`central-cdw5`) — data PASS, scaling FAIL

Production dump (read-only): 19 subsystems / 25,418 IOs / 3,244 L2 devices /
218 already-validated VFDs; one plc-sim per MCM serving ONLY its own tags;
12 bots; download storm across 19 controllers + VPN-profile cloud flap.
connect-all: **19/19 connected** in one shot.

| Invariant | Result |
|---|---|
| **I4** | **PASS — 3,560 verified writes across 19 MCMs, 0 true wipes, 0 suspect drops**, 1,306 explained SPARE rejections, queue drained to 0 — under flaps + download storm. |
| I3 | PASS — 4 downloads → 20 restore passes. Initial site assertion wrote ~660 flags across controllers; steady state verify-only. Mass-failure circuit breaker tripped repeatedly under saturation and backed off correctly (no freeze, no hammering). |
| I5 | PASS — 1 server.start (the round-1 double-audit fix verified). |
| I2 | PASS. |
| **I1** | **FAIL — p50 649 ms / p95 3.2 s / p99 3.9 s / max 8.3 s, 5 gaps >10 s.** Event-loop saturation: 19 concurrent PlcClients each run full-rate read cycles (~25k tags continuously) as if alone. CPU had headroom (tool ~204% of a 400% budget) — the bottleneck is the JS event loop. Scaling curve: p50 18 ms @ 4 MCMs → ~650 ms @ 19. Host caveat (same laptop ran 19 sims + cloud + bots) makes absolutes pessimistic, but the trend is the tool's own. **Action: per-MCM read-cycle stagger / adaptive cadence (scale cycle interval with connected-MCM count) or a shared read scheduler with a global CIP/FFI budget.** |

New findings:
- **Guard vs auto-pull tension (product decision needed):** the scoped pull's
  result-loss guard REFUSES the (never-forced) auto-pull for any MCM whose
  local holds values the cloud lacks. Two sources seen: (a) SPARE-Passed
  business rejections — local keeps the value forever, so that MCM stops
  auto-pulling cloud changes permanently (B9-shaped, one layer deeper);
  (b) harness comment asymmetry (fixed: cloud seed now mirrors Comments,
  same F3 class as results).
- **Sim fidelity:** MCM11/12/16-19 show 40-75% failed tags — real CDW5 tag
  name formats (FIOM `…_X3.PIN2_DI` style) don't match the patched ab_server's
  symbolic parser even though the tags are loaded. Tool handles it gracefully
  (connected, failed counted). Follow-up: extend patch_ab_server.py matching.
- Flap-count blind spot from round 1 still open (registry clients invisible to
  the observer's flap regex; I5 flap budget vacuous in central mode).

## Central round 3b — 2026-06-07, 1 h, 19 CDW5 MCMs + reader fix + realistic crew

Two fixes between rounds:
1. **Tool: batched status-sweep reads** (`readTagsBatchAsync`, frontend
   17b2292). Root cause of round-2's I1 failure was one setTimeout backoff
   chain PER TAG READ — 19 readers × ~1,300 tags ≈ hundreds of thousands of
   timers/sec. Now one sweep timer per 100-tag batch (identical CIP traffic),
   plus randomized reader-cycle stagger.
2. **Harness: realistic crew** (9296606). Bots fetched the UNSCOPED
   /api/ios (25k rows!) every think-cycle — ~8 site-wide JSON builds/sec
   saturated the loop by itself and confounded round 3's first attempt
   (discarded). Real clients fetch one MCM; bots now do too. Also: no more
   Passed on SPAREs (each refusal parked a row and jammed the scoped
   auto-pull at the result-loss guard).

| Invariant | Round 2 → Round 3b |
|---|---|
| I4 | PASS → **PASS, 2× throughput: 7,596 verified writes, 0 wipes, 0 suspect drops, 0 business rejections, queue drained** |
| I3 | PASS → PASS, same 282-flag restore **27.5 s → 8.8 s** |
| I1 | FAIL p50 649 / p95 3,170 / p99 3,926 ms → **FAIL p50 318 / p95 921 / p99 1,456 ms** (−51/−71/−63%), max 8.3 → 4.9 s, gaps>10 s 5 → 6 |

I1 remains formally red on this host (laptop also runs 19 sims + cloud +
12 bots). Residual cost: ~25k synchronous plc_tag_read FFI initiations per
cycle period (ffi-rs per-call floor) + per-MCM /api/ios serialization under
load. Next levers, in value order:
1. **Grouped-word expansion** — the reader already supports one read
   covering N bits (GroupedWord); most CDW5 tags read individually today.
2. **libplctag auto_sync** — push polling into C threads entirely
   (hardware-validation required).
3. Validate on real central-server hardware before treating laptop numbers
   as the tool's ceiling.

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

## MCM11 / CDW5 central-server incident — 2026-06-16 → new invariants I8, I9

First real central-server (`PLC_MODE=remote`) deployment surfaced three bugs the
rig could NOT have caught, because nothing asserted on the live channel or on
backup growth. All are now fixed; I8 + I9 added so a regression reds the build.

**Root causes (confirmed from the site's logs + source):**
1. **SSE auth contract break (cloud).** Cloud commit `3d58ce7` (deployed ~06-15)
   gated `/api/sync/events` behind a NextAuth browser session. The field tool
   subscribes with its per-project `X-API-Key` (no session) → permanent
   **HTTP 401** every 60 s, never recovering. The cloud's live "connected"
   presence IS the SSE subscription, so the portal showed the server/PLC **Red**
   even though the local PLC + REST pull/push were healthy. Pull/push were never
   affected (different routes, still accept `X-API-Key`). Fix: events route now
   authenticates via the shared `authorizeSubsystemIds` (session **or** scoped
   `X-API-Key`) — restores the live channel, keeps anonymous out. This is exactly
   B10's "SSE never reconnects" — but in PROD the cause was a deterministic 401,
   not docker-flap noise.
2. **Unbounded pre-pull backups (tool).** The pre-pull safety backup (full DB
   copy) ran before EVERY pull for EVERY active MCM with NO retention. AutoSync's
   15-min catch-up × 5 active MCMs ⇒ hundreds of full copies/day ⇒ disk hit
   ~4 GB / ~1,700 files. Fix: `pruneBackups()` (keep `BACKUP_RETENTION_KEEP`,
   default 300; 1 h min-age guard).
3. **No-op pull churn (tool).** The multi-MCM pull unconditionally
   DELETE+reinserted thousands of rows + took a backup every cycle even when the
   cloud was byte-identical. Fix: ported the single-MCM `id:version:result`
   change-hash into the per-MCM route — unchanged cloud ⇒ skip backup + rewrite.
4. **Connection reported from singleton only (tool).** `pushNetworkStatus` read
   the in-process SINGLETON client + single `config.subsystemId`; in REMOTE mode
   there is no in-process client, so it pushed `connected:false` for every MCM.
   Fix: report each active MCM from the mode-agnostic registry status; single-MCM
   tablets keep the untouched singleton path.

**I8 — live channel (SSE) auth (GATE, cloud-attached runs).** Scrapes tool logs
for `[CloudSSE]` outcomes. GATES on an HTTP **401/403** (the deterministic auth
break); transient `fetch failed`/`terminated` reconnect loops are recorded but
NEVER gate (same docker-network reason I7 is report-only).
→ **For I8 to pass, the `cloud` image must be rebuilt+pushed with fix #1**
(`ci/build_and_push.sh`); against a pre-fix cloud image I8 correctly reds.

**I9 — bounded auto-backups (GATE, always).** Counts `database-*.db` in
`/data/backups` + total size. Non-vacuous: judges retention only once `created >
keep` (a short smoke that never triggers pruning reports "not exercised" rather
than a false green); always gates an absolute runaway (> `BACKUP_DIR_MAX_MB`,
default 2048). Battle compose sets the tool's `BACKUP_RETENTION_KEEP=20` so a
soak with cloud edits exercises pruning.

## Incident → test coverage matrix (the "is it accounted for?" answer)

Goal: every KNOWN on-site failure has a scenario that REACHES it and a gated
invariant that CATCHES it. "100%" applies to known incident classes — unknown
unknowns can't be pre-written, which is why the soak runs broad chaos and the
matrix is revisited after every new incident. Honest status below.

| On-site incident | Reaching scenario | Gating invariant | Status |
|---|---|---|---|
| MCM11 SSE 401 → portal "Red", no real-time (2026-06-16) | `central` (cloud SSE + multi-MCM) | **I8** (gates on 401/403) | **COVERED** — needs the fixed `cloud` image (main) pulled into the rig |
| MCM11 unbounded pre-pull backups → 4 GB disk fill | `central` + `mutate` (pulls churn backups) | **I9** (count+size cap) | **COVERED** — `BACKUP_RETENTION_KEEP=20` makes pruning fire |
| MCM11 no-op pull churn (DELETE+reinsert every cycle) | `central` + `mutate` | **I9** (churn → backup growth) | **COVERED indirectly** — explicit churn metric is a TODO (count "Cleared N existing IOs" with no cloud change) |
| MCM11 per-MCM connection singleton-only → other MCMs "Red" (#4) | `central` / `central-cdw5-split` | partial via **I8**; per-MCM connected-flag | **PARTIAL** — dominant cause (SSE) gated; the singleton network-status flag is a residual report-gap |
| MCM08 pull wiped 818 results (2026-06-04) | `s3` (offline queue) + `mutate` | **I4** (no data loss) + pre-pull backup | COVERED |
| B1 — HTTP 429 silent result-drop (MCM11 class) | `s3` (cloud flap → 429-ish) | **I4** `suspect_silent_drops` | COVERED (reproduced + fixed v2.40.3) |
| MCM02 freeze — VFD writer blocked event loop | `s1`/`central` under load | **I1** responsiveness + **I2** leak | COVERED (caught v2.40.1 freeze) |
| Polarity/flag wipe on PLC program download | `s2` (download storm) | **I3** (restore after download) | COVERED |
| Generic field-write loss / work interruption | all scenarios | **I4** + **I1**/**I5** | COVERED |
| Cloud→field propagation (additions don't arrive) | `mutate` | **I7** (report-only; env-dependent) | PARTIAL — see B10 |

**Rollout required for this matrix to be REAL (not just authored):**
1. **Rebuild + push the heavy images from main** (`ci/build_and_push.sh`): the
   `tool` image must include the backup-retention / no-op-pull / per-MCM
   connection / firmware fixes, and the `cloud` image must include the
   `/api/sync/events` X-API-Key fix — else CI tests STALE binaries (image-
   freshness gotcha) and I8 reds against the pre-fix cloud.
2. **`central` is now in the weekday rotation (Wed + Sun)** so the SITE topology
   is exercised routinely, not just manually. For full-site depth, point a
   GitLab schedule at `central-cdw5-split` (19 real MCMs, PLC_MODE=remote) — that
   needs the CDW5 19-MCM seed package, so it stays a dedicated schedule, not the
   MCM02-seeded nightly.
3. **Validate the new gates per skill rule #4:** run `central` TWICE green before
   trusting I8/I9 there (a flapping gate is worse than none).

**Residual gaps (be honest):** (a) no explicit no-op-churn gate (I9 catches the
harmful symptom, not the wasted rewrites); (b) per-MCM connected-flag isn't its
own gate yet; (c) I7 stays report-only (docker-network flap doesn't cleanly
restore SSE — env, not tool). None of these are data-loss paths.

---

## delta scenario — cloud→field delta-sync coverage (2026-06-24)

**What it stresses:** the NEW delta-sync path (admin CRUD → `recordChange` +
`subsystem_change_log` → `subsystem_changed` SSE hint → field `fetchAndApplyDelta`
granular upsert/guarded-delete + per-subsystem cursor). The original `mutate`/I7
scenario can't reach it: its mutator writes raw SQL (no `recordChange`, no hint)
and the battle `cloud` is a prod build (no admin auth → can't drive the API).

**How:** a dev-mode cloud image (`battle/cloud-dev`, `next dev` +
`DEV_BYPASS_AUTH=true`) lets the mutator (`MUTATE_MODE=api`) sign in as dev-admin
and drive the REAL admin API (POST/DELETE `/api/admin/ios`), firing the in-process
`recordChange` + hint. The field (same prod tool image, `CLOUD_URL_OVERRIDE`)
applies the resulting deltas. Run: `SCENARIO=delta SOAK_MINUTES=10 sh ci/run_scenario.sh`
(builds `cloud-dev:local`); CI job `battle-delta` pulls `cloud-dev:latest`.

**Invariants (REPORT-ONLY until proven green twice — skill rule #4):**
- **I11 delta-propagation** — cloud adds converge in local SQLite AND arrived via
  the granular delta path (`[AutoSync] delta` log lines), not a full pull.
- **I12 delete-propagation + guarded delete** — cloud deletes remove clean local
  IOs; an IO with an un-pushed local result (PendingSyncs) is NEVER dropped.
- **I13 cold-start cursor** — `SyncCursors.LastSeq` advances past 0 (proves the
  resync→full-pull→seed-cursor handshake works and deltas actually run, rather
  than resyncing forever — the cold-start bug caught during live dev testing).

**Promote I11/I12/I13 to GATE** once two consecutive clean `delta` runs are green.

### delta run #1 (2026-06-24) — REAL findings, not yet green

I4 green (293 writes, no loss — harness is real). I11/I7 FAIL (0 cloud adds
propagated), I13 cursor=0. Field log (`tool-logs/logs/app-2026-06-24.log`) shows
the root causes:

1. **Catch-up pull is GATED under load.** `[AutoSync] catch-up done: 38:skip-pending`
   every time — the reconnect/periodic full pull returns 409 while the bot
   offline queue is non-empty (continuous testing), so cloud→field propagation
   STALLS under load. This is a real product issue affecting the deployed
   full-pull path, not just the rig. Fix: make the catch-up **delta-first**
   (granular apply is non-gated) — auto-sync Task 2.8, still open.
2. **The SSE `subsystem_changed` hint is never received** (grep=0) under the
   dev-mode cloud. Almost certainly `next dev` module isolation: the admin
   route's in-process `broadcastSubsystemChanged` emits to a different emitter
   instance than the SSE route's subscriber. PROD (`next start`, true singleton)
   works, but the `cloud-dev` (next dev) harness can't deliver it.

**Design fork for testing the hint path in the rig** (pick one):
- (a) small **test-only admin auth seam** in the cloud (accept admin via a
  header gated by a battle-only env) so a PROD-mode cloud image — real singleton
  emitter — can be driven by the mutator → real hint→delta; OR
- (b) accept the rig only tests the **catch-up-delta** path (make catch-up
  delta-first + frequent), and rely on unit tests + the live dev-cloud curl
  proof for the hint itself.

Cold-start cursor-seed (cloud `cursorSeq` + field seed after baseline pull) is
committed (402842c / dd34730) and is a prerequisite for either path.

### delta run #2 (2026-06-24) — RIG CAUGHT A REAL DEFECT

With delta-first catch-up + cursor-seed: I13 PASS (cursor=30), I4 green (288),
I12 pass. **I11/I7 still FAIL** (0 propagated). Field log: `38:resync->skip-pending`
every catch-up.

**Root cause (real product defect, would bite in production):** under continuous
field activity the offline queue is never empty, so the resync→full-pull is
GATED (409 skip-pending) and the baseline IOs are never pulled. Seeding the
cursor anyway (to the cloud max seq) makes it worse — it advances past changes
that were never applied, so the next `delta(since=max)` returns nothing and the
new cloud IOs fall into a PERMANENT GAP. Net: while a tech is actively testing,
cloud-side CRUD silently fails to reach the tablet.

**Correct fix (not yet implemented — needs care + a verification soak):** on
resync, the delta endpoint should deliver the IO SNAPSHOT through the non-gated
granular apply path — return all current IOs as `upserts` (serialized like the
full pull), applied by `fetchAndApplyDelta` (preserves local results, NOT
queue-gated), then seed the cursor to `toSeq`. This replaces the gated
destructive full pull on the cold-start/resync path and closes the gap. The
`seed-cursor-even-when-full-pull-skips` shortcut (commit 33f5961) must be
REVERTED as part of this — it is unsafe (creates the gap).

This is the rig doing its job: a defect unit tests + the happy-path live proof
missed. Implement the snapshot-on-resync fix, then re-run `delta` twice green.

### delta run #3 (2026-06-24) — FIX VERIFIED (1st green)

With snapshot-on-resync (cloud f424618 / field 34ab59c): **I11 PASS** (18 adds,
0 missing, arrived_via_delta=true), **I12 PASS**, **I13 PASS** (cursor=30), I4
green (276). Field log: `catch-up done: 38:delta(+1184/-0)` → `38:delta(+1202/-0)`
— the snapshot bootstraps via the non-gated granular path, cursor advances, and
later cloud adds arrive as true deltas under continuous load. The cold-start gap
is closed.

I7 (legacy full-pull reconnect path, report-only) improved 24→6 missing; it's
superseded by the delta path (I11) for propagation and stays report-only.

REMAINING before promoting I11/I12/I13 to GATE: one more clean `delta` run
(skill rule #4 — green twice). This was the agreed single-soak checkpoint; the
confirming run is a deliberate follow-up.

## I18 — FV/L2 cell survival invariant (2026-07-04) — code done, REPORT-ONLY pending 2 greens

**Why.** The MCM17 investigation showed FV (L2 cell) work had NO battle
coverage: `FV_FRACTION` defaulted to 0 in every scenario (bots wrote zero FV
cells), and the only FV invariant (I15) verifies cloud→field propagation, not
survival of field-written work. FV loss — the exact reported field incident —
would sail through every nightly green.

**What.**
- `ci/run_scenario.sh` — global `FV_FRACTION=${FV_FRACTION:-0.15}` so every
  scenario now generates FV cell writes through `/api/l2/cell` → `L2PendingSyncs`.
- `observer/probe.py` — `journaled_fv()` (action:'fv' status-200 lines, per-bot
  append order, multi-writer cells excluded — the journaled_results() discipline)
  + `check_i18_fv_survival()`: at quiesce, every single-writer FV cell's local
  `L2CellValues.Value` must equal the last journaled value. Self-quiesces on
  cloud-less runs (STOP-sentinel guard). Reports `soak_fv_writes`/`vacuous` so a
  0-write run is visibly meaningless, plus active/parked L2 queue depth at end
  for mismatch diagnosis. Runs AFTER the I14-17 block, so on mutate runs it
  judges the post-pull-l2 state — a destructive pull wiping unpushed FV work
  trips it (tool-side fixes shipped on `harden/fv-l2-durability-audit`:
  scoped full-pull delegation, l2.cell recovery-journal, FV orphan reconciler).

**Gate plan (skill rule #4).** REPORT-ONLY until two clean soaks show
`pass:true` with `soak_fv_writes > 0`; then move `I18_fv_survival` out of
REPORT_ONLY — it is the FV analogue of I4 and is intended to GATE. NOTE: the
tool image must be rebuilt+pushed (`ci/build_and_push.sh`) before the soak or
CI exercises stale binaries without the FV hardening.

Syntax-checked (`py_compile`, `sh -n`). Not yet run on a soak.

## I8_FV — typed-FV data-loss, journal→local→CLOUD (2026-07-08) — REPORT-ONLY, pending 2 greens

**What it stresses.** The FULL FV loss surface, end-to-end: crew bots type
unique traceable values (`BOT<n>-<counter>`) into owned L2 cells via the real
`POST /api/l2/cell` (→ `L2PendingSyncs` → cloud `/api/sync/l2/update`), journal
each accepted write as a distinct `kind:'l2'` record (append order — never
ts-sorted), and at quiesce the observer's `check_fv_data_loss()` verifies every
single-writer cell's last journaled value against BOTH stores:
- **local** `L2CellValues` → `fv_missing_local` (absent/blank — the MCM17
  destructive-pull wipe class) / `fv_divergent` (different value);
- **cloud-stage** via the real field pull source `GET /api/sync/l2/<sid>`
  (local→cloud ids via `L2Devices.CloudId`/`L2Columns.CloudId`) →
  `fv_missing_cloud`, judged ONLY once the L2 queue drained; queue-not-drained /
  cloud-unreachable ⇒ cloud check `inconclusive`, never a fail (I7 discipline);
  parked-row cells are skipped-as-safe; unmapped (no CloudId) cells reported
  separately (the tool audit-logs those as `l2.push.drop`).

Relationship to **I18**: I18 stays as-is (journal→local only). I8_FV adds the
cloud leg — the FV analogue of I4's full reconciliation. Both read the same
journal lines (the fv writes now carry both `action:'fv'` and `kind:'l2'`).

**Ownership/exclusion.** Unchanged single-writer discipline: bots own FV
devices by `device.id % BOTS` (non-VFD only — the fv/vfdwizard disjointness
fix), columns scoped to the device's sheet + editable/non-system; the observer
still excludes any cell touched by >1 bot. Bots log LOUDLY at startup how many
FV cells they own (`FV writable cells owned at startup = N`); a seed with no
writable L2 cells ⇒ `fv_writes=0` ⇒ `inconclusive:true`, never a vacuous verdict.

**Knobs.** `FV_WRITE_CHANCE` (default 0.2) exported globally by
`ci/run_scenario.sh` + forwarded by compose; an explicit `FV_FRACTION>0`
(scenario tuning, e.g. all/features/slowlink at 0.15) still wins;
`FV_WRITE_CHANCE=0` is the off-switch.

**Gate plan (skill rule #4).** `I8_FV` is REPORT-ONLY — in `REPORT_ONLY`, does
NOT affect `verdict.pass`. **Flip to GATE after two consecutive clean nightly
runs with `fv_writes > 0` and a conclusive cloud check.** Authored on a no-
Docker box: syntax-checked only (`node --check`, `py_compile`), NOT yet run on
a soak. Note: ENGINEERING-REPORT.html does not exist in `battle/`; the
invariants table in the historical `REPORT.html` (stakeholder snapshot,
I1–I7 era) was deliberately left untouched.

**Gate-correctness validation (2026-07-06, features 20min):** after the disjoint
fv/vfd-wizard-device + sheet-scoped-column fix, **I18 FV 0 mismatches (492) and
I26 VFD-wizard 0 mismatches (230)** — both non-vacuous and trustworthy. I22/I23
0, I24 non-vacuous (63), I4 0 wipes/0 drops. Residual: I25 punchlist 1/119
(rare re-test-clears-punchlist edge, report-only, not loss). Only GATING failure
across all soaks is I1 responsiveness (the async-write architectural item —
docs/superpowers/plans/2026-07-06-field-tool-hardening-verdict.md). Four harness
bugs caught+fixed before any release decision: blocker deviceName casing,
feature-fraction default shadowing, I25 re-test false-positive, I18/I26
cross-action contention + invalid-column.

## 2026-07-08 — I8_FV first live run (smoke ci-all-1233): GREEN, plumbing proven
15-min `all` smoke on sha e939ca2 (crew/observer rebuilt; tool image = registry latest).
Verdict pass=true. I8_FV: fv_writes=416, judged=343 (single-writer), missing_local=0,
divergent=0; cloud leg correctly INCONCLUSIVE — L2 queue not drained at soak end
(active=185, parked=963) → "pushes pending, not loss". Precondition-awareness worked on
run #1; no false fail. Counts as clean run 1 of 2 toward flipping I8_FV to GATE.
Follow-ups:
1. IMAGE FRESHNESS: the tool image in the registry predates the v2.43.0 non-destructive
   FV pull — rebuild+push (ci/build_and_push.sh from a disk-rich box) so the nightly
   exercises the NEW pull path; until then I8_FV local leg is testing the old binary.
2. 963 PARKED L2 rows in 15min is high — likely seed/cloud-stage version mismatch making
   cloud reject bot pushes (parked ≠ lost, and the invariant classified it safely), but
   check the park reasons on the next nightly before flipping to GATE.

## 2026-07-08 — plc-sim serves CIP Identity; guided firmware step LIVE-VERIFIED
The sim now answers Get_Attributes_All on the Identity Object (Class 0x01,
Instance 1) — canned 1756-L85E BATTLE-SIM/B, vendor 1, productCode 168,
rev 33.11 (patch 3 in `plc-sim/patch_ab_server.py`, both connected and
unconnected dispatchers). Before this, the field tool's firmware scan read the
controller as `unreachable` and the whole firmware-compliance feature was
untestable on the rig. Verdicts are now drivable purely from data: edit
`approved_firmware` in cloud-stage (min 32.0 → compliant; 34.1 → non_compliant;
no row → no_baseline) — no rebuilds.

Used it to close the spec's required live check of the guided `firmware_check`
auto_detect step (bot-free stack + Playwright on :13000, subsystem 38): scan
kicks on step entry, GET /api/firmware polls at 2.5s, banner fail/pass/RE-SCAN
all correct, RECORD PASS completes via GuidedTaskState and the task is not
re-served. Found+fixed live: zero non-compliant devices rendered "ALL N
COMPLIANT" even when every device was no_baseline/unreachable — a false pass;
runner now reports "N OF M UNVERIFIED — NO BASELINE / UNREACHABLE" (gray).
Gotcha reminder: `up` re-runs the seeder (KEEP_DATA=0) which re-seeds the tool
DB — guided/firmware state does NOT survive a stack recreate; that's the
harness, not a persistence bug (verified: the GuidedTaskState write persists).

## 2026-07-12 — I8_FV vs cloud-flap on the NEW binary (s3, 30min, FV-heavy): GREEN — reconnections cannot wipe FV
Purpose-built proof run for the "constant reconnections were wiping FV" hypothesis
(2026-07-11 incident follow-up). Tool image rebuilt LOCALLY from main 9963447 —
first soak exercising the v2.43.0 non-destructive FV pull + the FV-hardening
batch (this closes the 07-08 follow-up #1 for local runs; registry image still
needs build_and_push for the nightly). SCENARIO=s3 (link down 2min of every 6 —
~5 full disconnect/reconnect cycles), FV_FRACTION=0.4, HOT_FRACTION=0, 6 bots.

Verdict pass=true. **I8_FV: fv_writes=497, judged=386 (single-writer),
missing_local=0, divergent=0.** I18: 386/0 mismatches (non-vacuous). I4: 406 IO
writes, 0 wipes, 0 silent drops. I1 p95 8.9ms, 0 gaps. Cloud leg
inconclusive-safe (active=71 still draining at judgment — pending, not loss).
Counts as clean run 2 of 2 toward flipping I8_FV to GATE (run 1 = 07-08), BUT
that run was the old binary — recommend one more nightly on a freshly pushed
registry image before the flip.

Known-explained: l2_pending_parked_at_end=1063 — the L2 drain counts version
conflicts as strikes (rebase +1 each), and bot-speed re-edits of the same cell
during a flap burn the cap. Values verified present locally (I8_FV) and the
park message points at cloud having them. Real techs don't re-edit one cell 10×
in minutes; still, this is drift dimension #1 in SYNC-HARDENING-PLAN's
queue-unification section (IO defers conflicts to B7 with 2× cap; L2 strikes)
— resolve there, not by tuning the harness.

## 2026-07-12 — v2.43.1 RELEASE soak (all, 60min, fresh tool+cloud images): FULL PASS
Release-gate run for v2.43.1 (tag 9c66945) with BOTH heavy images rebuilt from
the shipped code (tool = v2.43.1 tree incl. remote-ops/quarantine/updating-
freeze; cloud = today's deployed f871cdc/6b3fe3e with tolerant heartbeat +
fleet alerts). SCENARIO=all: download storm + cloud flap 3-12min + mutator +
full feature fractions.

Verdict pass=true, every gate green and non-vacuous:
I4 482 IO writes / 0 wipes / 0 silent drops; I8_FV 1,718 FV writes / 0 missing
/ 0 divergent; I18 908 judged / 0 mismatches; I22 estop 0, I23 guided (48) 0,
I24 blocker (72) 0, I25 punchlist (205) + deps (248) 0/0, I26 vfd-wizard (318)
0 mismatches. I3 1 injected download → restores seen. I1 p95 19.4ms, 0 gaps.
I7 inconclusive-safe (queue never drained under continuous chaos — pull
correctly deferred). I2/I20 inconclusive by design (<120min window — nightly's
job). The new heartbeat queueStats/auditCounters fields flowed through the
tolerant cloud heartbeat without issue.

## 2026-07-13 — restart/power-cut survival (s3 flap + toolkill): FULL PASS + harness fix
The FV-loss hypothesis was "restart or reconnect-to-cloud clears local work
because cloud has no connection to sync to." Tested directly.

HARNESS FIX (chaos_api.py do_toolkill): a SIGKILL via the Docker API does NOT
trigger the compose restart policy — the first attempt (25min run) left the
tool DOWN for the rest of the soak (server_starts=1, i.e. never came back), so
"power cut" was silently a "dead box" test. do_toolkill now SIGKILLs, waits 5s
(the dark window), then explicitly POSTs /start — a true power-CYCLE.

15-min s3 (link down 2 of every 6 min, FV-heavy, 6 bots) + one power-cycle at
~6.5min WITH unsynced work queued and the cloud link flapping (forces the
restart→reconnect→pull-from-a-cloud-that's-missing-my-work path):
verdict pass=true, server_starts=2 (kill+start both docker 204),
I4 266 writes / 0 wipes / 0 silent drops, I8_FV 248 FV writes / 219 judged /
0 missing local / 0 divergent, I18 0 mismatches, I3 2 restores seen.
Conclusion: a hard power-cycle followed by reconnect to a behind cloud does
NOT clear local FV/IO work. The earlier 25-min dead-box run also showed 0
wipes (work survived on disk while the tool stayed down). The full triad is
now proven: nonstop reconnects, hard power-off, and power-cycle-with-unsynced
-work — none clear local work.

## Sync Center + blocker-clear validation soak (2026-07-15)

Rebuilt `battle/tool:local` from working tree (Sync Center `772b80f` + blocker
clear-on-progress `0ceecd4`), ran `all` / 20 min on the dev box (throwaway
prod-copy cloud, prod never touched). **Verdict PASS.**
- I4 no-data-loss ✅ 492 writes, 0 true_wipes, **0 suspect_silent_drops**, 0
  pending at end — the new Sync Center queue ops + fast-park (403/404) engine
  change introduce no loss under chaos.
- I24 blocker-survival ✅ 53 blocker writes, 0 pending active/parked (not
  vacuous) — set/clear path drains; I26 VFD-wizard ✅ 131 writes/0 mismatch.
- I18/I8 FV ✅ (464/597, 0 mismatch/missing); I1 ✅ (p95 19ms — better than the
  v2.42.11 baseline that FAILED I1).
- Report-only misses (non-gating, untouched paths): I7 cloud→field pull
  (15 cloud adds not pulled — mutate precondition, not the sync fixes) and I25
  deps (4 mismatches). Both pre-existing, unrelated to this work — flagged for
  a separate look.

## Guided-mode correctness fixes — soak + new fault-path E2E (2026-07-20)

Rebuilt `battle/tool:local` from the working tree (guided fixes `6894cdd` +
async-FFI `9b60482`) and ran `all` / 15 min. **Verdict PASS.**
- I4 no-data-loss ✅ 477 writes, 0 true_wipes, **0 suspect_silent_drops**, 0
  pending at end. The guided write-path changes (Trade/blocker columns on the
  PendingSync, FailureMode/Trade nulled on clear, MCM-ownership 409) introduce
  no loss under chaos.
- I23 guided-survival ✅ 45 guided writes, 0 mismatches, **not vacuous**.
- I8/I18 FV ✅ 394 writes / 329 judged, 0 missing, 0 divergent. I22 e-stop ✅ 32.
  I24 blocker ✅ 45, I25 punchlist ✅ 59/67, I26 VFD wizard ✅ 76 — none vacuous.
- I5 ✅ 1 server start / 0 PLC flaps — the writeOutputBit/readOutputBit
  sync→async conversion did not destabilise the PLC layer.

⚠️ Two caveats on that run — BOTH since chased down, see the next entry.
- I7 failed (9 cloud adds not propagated, queue drained). Report-only, and the
  same pre-existing miss recorded on 2026-07-15 — unrelated to this work.

### New: `frontend/e2e/guided-fault-paths.spec.ts` (Playwright)
`guided-task-runner.tsx` (~1500 lines) had NO coverage, and BOTH audit
CRITICALs lived there. These behaviours only appear when a request FAILS, which
a `node`-env vitest cannot reach. Playwright route interception forces each one.
Green against the battle tool (`BASE_URL=http://localhost:13010 SUBSYSTEM_ID=38`):
- firmware FAIL is honest + leaves the task **available** (the CRITICAL, locked)
- a dead `/api/guided/system-status` poll degrades the ring chip to **NO READING**
  instead of holding a stale "NOMINAL" (the fail-open safety gate)
- a rejected skip keeps the task active and says so

Two specs skip on this rig by design, and need a seeded fixture to run:
`fire-output` 503 needs an `io_check` step (battle's map resolves 0 devices), and
the L2-outbox spec needs a workable functional task (all 192 are Phase-2 blocked).

## Two rig bugs that manufacture FALSE verdicts (2026-07-20, follow-up)

Chasing the two caveats above turned up two harness defects. Neither is a tool
bug; both make a soak lie, in opposite directions.

### 1. `server_starts` accumulates across container recreations → FALSE I5 FAIL
A 15-min `all` run reported **I5 FAIL, server_starts=4** (gate allows
`1 + toolkills`, and zero toolkills were injected). It looked exactly like a
crash loop in the just-landed sync→async `writeOutputBit` conversion.

It was not. `server_starts` counts `"server.start"` records in
`/data/logs/audit-*.jsonl`, the seeder replaces `database.db` but **never
clears `logs/`**, and the `tool-data` volume survives `compose down`. Every
`up -d tool` during the day's E2E work appended another start. Re-run after
`compose down -v`: **server_starts=1, verdict PASS** — the async conversion is
exonerated (I5 plc_flaps=0, I4 484 writes / 0 wipes / 0 suspect_silent_drops,
I23 43 guided writes / 0 mismatches / not vacuous).

**Rule: a verdict is only valid from a wiped volume.** `compose down` alone
carries audit history into the next run's I5. Judge I5 from `down -v` runs only,
or teach the seeder to truncate `logs/`.

### 2. The `all` scenario HARDCODED its chaos knobs → VACUOUS I3 green
`run_scenario.sh` `all)` did `export DOWNLOAD_STORM="25,45"` unconditionally,
clobbering the caller's value. At `SOAK_MINUTES=15` the first download is due at
25-45min, so **it never fires**: `injected_downloads=0`, while I3 still reported
**pass** off 4 unrelated cloud-flap reconnect restores. A gate that verified
nothing and said green — the same vacuous-green class the harness warns about
for `soak_writes=0`.

PARTIALLY fixed — **and I3 is still vacuous. Do not trust it.**
`all)` now uses `${DOWNLOAD_STORM:-25,45}` / `${CLOUD_FLAP:-3,12}` /
`${FLAP_BUDGET:-120}`, which removes the clobber (the 480min nightly is
unchanged). But a 6min verification run with `DOWNLOAD_STORM="1,2"` STILL
injected zero downloads — `injected.jsonl` held only cloudcut/calm. So the
hardcode was not the whole cause and the real blocker is NOT yet identified.
The chaos service does receive `DOWNLOAD_STORM: ${DOWNLOAD_STORM:-}`
(docker-compose.battle.yml:465), so the next place to look is the download loop
in `chaos/chaos_api.py` and whether it is gated on something else (a profile, a
sim target, or a parse of the "min,max" form).

⚠️ Worse than the vacuousness itself: **I3 returns `pass: true` when
`injected_downloads == 0`.** A gate that verifies nothing reports green. Until
the injector is fixed, I3 evidence should be read as "0 downloads injected =
NOT TESTED", and the check itself should arguably return inconclusive/fail
rather than pass on an empty sample (same treatment I4 gets for
`soak_writes=0`).

### Also fixed this pass
`battle_cloud`/`tool` host ports are overridable (`BATTLE_CLOUD_PORT` /
`BATTLE_TOOL_PORT`) — a soak previously could not start at all while a local dev
cloud held 13001, and the failure surfaced as a bare compose port-bind error.

### Standing: I7
Fails identically to 2026-07-15 (9 cloud adds not propagated, queue drained).
Pre-existing, report-only, unrelated to this work.

## Why guided IO has NEVER been battle-tested — three gates, not one (2026-07-21)

Built `s7` to drive the real guided loop (pool → steps → `/api/guided/test`)
and a new **I27_guided_io_loop** invariant. I27 correctly reported
`vacuous=True, pass=False, "NOT TESTED"` — it refuses to green-light a path
that never ran, unlike I3 (passes on 0 injected downloads) and I23 (see below).

**First: what I23 actually covers.** The crew's "guided" action posts SYNTHETIC
task ids (`battle-guided-38-bot2-5`) to `/api/guided/tasks/complete|skip`. It
proves the `GuidedTaskState` override table syncs — nothing more. It has never
built a pool, fetched a step, or called `/api/guided/test`. "I23 guided writes:
43, 0 mismatches" reads like guided coverage and is not.

**Three gates block a workable io_check task, and I only knew about one:**
1. `McmDiagrams` empty → 0 devices → 0 io_check tasks. FIXED (see prior entry).
2. Every IO already has a result (real commissioned seed) → all 100 io_check
   tasks derive to `completed`. FIXED: `GUIDED_CLEAR_DEVICES` clears a device
   slice (verified: 189 IOs on 12 devices).
3. **STILL BLOCKING — and this is the real one.** With the first two fixed, all
   12 cleared tasks are still `blocked`:
   - **12/12 on "All Network Loop tasks must be done"** — io_check is gated on
     network_loop completion, and nothing in the rig ever completes it.
   - **4/12 additionally on the D6 NC pre-check** — e.g. `UL21_2_VFD:SI.In00Data
     reads FALSE at rest — NC device must read TRUE`. The engine is behaving
     CORRECTLY: it is catching what looks like a miswire. The rig is at fault —
     **plc-sim does not model rest states**, so every NC safety point reads
     FALSE and guided rightly refuses to test it.

### To actually close this
- Complete `network_loop` as scenario setup (POST `/api/guided/tasks/complete`),
  or seed `NetworkRings` healthy so it derives complete.
- Teach the seeder to emit rest-state initial values in `/gen/tags.txt` so NC
  points boot TRUE. Without this the D6 pre-check will always (correctly) block
  safety io_check, and the auto-detect round-trip can never be exercised.

`s7` + `GUIDED_CLEAR_DEVICES` + `GUIDED_IO_FRACTION` + the bot's guided walk +
I27 are all committed and correct; they are blocked on gate 3, not broken.
I27 stays report-only until it has two clean non-vacuous runs (rig rule #4).

**Standing signal:** while I27 reports `vacuous`, guided's core loop — D6
round-trip auto-detect, swap detection, fire-output — has **zero** automated
coverage in this rig. Do not read a green soak as guided IO being exercised.

### s7 attempt 2 — network_loop setup added, STILL vacuous (2026-07-21)
Added a one-shot guided setup on bot 1: complete every `network_loop` task, the
gate that blocked 12/12 cleared io_check tasks. Re-ran s7/10min:
**I27 still `guided_io_writes=0, vacuous=True, pass=False`.**

Could not diagnose further: **the crew container's stdout is not collected into
`battle-artifacts/`** (only tool/cloud/observer are), and `compose up -d`
detaches, so the run log has no crew output either. There is no record of
whether the setup call fired, whether network_loop actually completed, or
whether the walk found a workable task.

**Next step is therefore a rig fix, not a guess: collect crew logs into the run
artifacts.** Without that, every guided-walk iteration is blind. After that,
the open question stays gate 3 — the D6 NC pre-check needs plc-sim to model
rest states (NC points must boot TRUE), which may not be expressible in
ab_server's tag syntax and should be scoped before it is attempted.

I27 continues to correctly report NOT TESTED. Treat guided's core loop (D6
round-trip, swap detection, fire-output) as having ZERO automated coverage.
