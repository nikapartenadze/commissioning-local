---
name: battle-test
description: Use when working on the commissioning field-tool BATTLE-TEST pipeline — the automated chaos/soak rig under `battle/`. Covers running soaks, reading verdicts, adding scenarios or invariants, the GitLab CI nightly, and the hard-won gotchas. Invoke whenever the task touches `battle/`, the nightly soak, the observer invariants (I1–I7), the crew bots, chaos injection, or "battle"/"soak"/"chaos test" of the local tool.
---

# Battle-Test — operating the chaos/soak rig

The field tool (`frontend/`) ships the actual product image into a Docker stack, gets driven by simulated technicians, hammered with injected faults for hours, and judged by machine-checked invariants — every night, before any build reaches a tablet. Everything lives in **`battle/`** at the workspace root. **Never touch production** — the cloud here is a throwaway Postgres seeded from a *copy* of field data.

When invoked, load this file, then read `battle/FINDINGS.md` (per-run engineering log) for the latest state. Companion visuals: `battle/ARCHITECTURE.html`, `battle/ENGINEERING-REPORT.html`.

## Mental model

Real shipped image + real field dataset (MCM02: 1,184 IOs / 72 VFDs) → simulated crew marking pass/fail → inject chaos (PLC downloads, power cuts, cloud flaps, crashes, cloud-side edits) → an external **observer** probes `/api/health` every 1 s and scrapes logs → emits a PASS/FAIL **verdict** with artifacts. The crew journal (what the field *wrote*) is the ground truth the data-loss check compares against.

**Golden rule of judging: judge a QUIESCENT system.** The bots and mutator loop forever; the observer drops a `STOP` sentinel at soak end, waits for them to go quiet, *then* snapshots. Without this, every verdict is racy (see Gotchas).

## Architecture (one `docker compose -p battle` project)

| Service | Role | Built or pulled |
|---|---|---|
| `tool` | **System under test** — the real field image (Express+SQLite+PLC+sync) | pulled from registry (CI) |
| `cloud-stage` | Real commissioning-cloud image + throwaway Postgres (`cloud-db`) | pulled |
| `plc-sim` | Patched libplctag `ab_server` — real CIP, ~1,644 tags; **restart = PLC program download** | pulled |
| `seeder` | Loads the MCM02 seed DB into tool + cloud | built |
| `crew` | N bots = simulated technicians (`crew/bot.mjs`) | built |
| `chaos` | Fault injector via Docker socket (`chaos/chaos_api.py`) | built |
| `cloud-mutator` | Cloud-side edits/additions (`cloud-mutator/mutate.sh`), `mutate` profile | built |
| `observer` | The verdict (`observer/probe.py`) — invariants → exit code + `verdict.json` | built |

CI **pulls** the 3 heavy images (`tool`/`cloud`/`plc-sim`) from the registry and **builds** the tiny ones fresh each run. The heavy ones are too big for the ci-runner's disk — push them from a dev box / dh1 via `battle/ci/build_and_push.sh`.

## The invariants (`observer/probe.py`)

GATE = fails the build. report = recorded only.

| ID | Checks | Gate | Notes |
|---|---|---|---|
| I1 | Responsiveness — `/api/health` p95 + max gap | GATE | 120 s boot warm-up excluded |
| I2 | No memory leak — RSS slope | GATE | |
| I3 | Flag restore after PLC download (polarity/VFD writeback) | GATE | injected downloads must each show a restore |
| I4 | **No data loss** — crew journal survives in local SQLite; nothing silently dropped | GATE | the headline; see below |
| I5 | Stability — server starts / PLC flaps vs budget | GATE | |
| I7 | Cloud→field propagation (mutate scenario) | report | precondition-aware (see below) |

**I4 detail (most important + most subtle):**
- `suspect_silent_drops` = the **real** loss detector (B1 429 / B7 version-cap drops on a non-business reason). This is the MCM11 class. **If this is >0, it's a real tool bug.**
- `true_wipes` = a heuristic: a field write whose value is now NULL in local. Useful but noise-prone under concurrency — only trustworthy with single-writer IOs and a quiescent snapshot.
- `divergence_lww_or_business` = local≠cloud but explained (last-write-wins or SPARE rejection) → reported, not failed.
- `norm("Cleared") → None` (a cleared result reads as NULL in both stores).

## Scenarios (`battle/ci/run_scenario.sh`)

| Key | Throws | Verifies |
|---|---|---|
| `s1` | clean scale soak | I1·I2·I5 |
| `s2` | PLC download storm (`DOWNLOAD_STORM="20,40"`) | I3·I4 |
| `s3` | cloud flap (`CLOUD_FLAP="2,6"`, `FLAP_BUDGET`) | I4 offline-queue |
| `s6` | CIP-saturated controller (`DELAY_MS`) | I1·I5 |
| `mutate` | cloud-side edits (`COMPOSE_PROFILES=mutate`, `HOT_FRACTION=0`) | I7 |
| `all` | **everything at once** (the nightly) | all |

Knobs (env): `SOAK_MINUTES`, `BOTS`, `DOWNLOAD_STORM="min,max"` (minutes), `CLOUD_FLAP="up,down"`+`FLAP_BUDGET`, `DELAY_MS`, `COMPOSE_PROFILES=mutate`, `MUTATE_PERIOD_SEC`, `HOT_FRACTION` (0–1), `THINK_MIN_MS`/`THINK_MAX_MS`.

## Run it

```sh
# Local (needs Docker):
cd battle && SCENARIO=all SOAK_MINUTES=15 sh ci/run_scenario.sh

# CI ad-hoc smoke — trigger a pipeline with vars:
#   RUN_SMOKE=1  SCENARIO=all|s2|s3|mutate|...  SOAK_MINUTES=15
# Nightly: schedule id 1, cron "0 2 * * *" Asia/Tbilisi, SCENARIO=all SOAK_MINUTES=480
```

GitLab: host `gitlab.lci.ge`, project **id 24** (`commissioning/commissioning-local`), registry `registry.gitlab.lci.ge/commissioning/commissioning-local/{tool,cloud,plc-sim}`. CI runs on the shared `tracker-ci-dind` runner (DinD). Seed DB comes from the generic package registry `battle-seed/1/database.db` (git-ignored field data).

**API token:** don't hardcode/commit a PAT. Mint a fresh one on the GitLab server:
`ssh root@<gitlab-host> "gitlab-rails runner \"puts User.find_by_username('root').personal_access_tokens.create!(scopes:['api'],name:'battle',expires_at:30.days.from_now).token\""`

Trigger + watch + read verdict (replace `$TOK`, `$P`):
```sh
curl -s --request POST --header "PRIVATE-TOKEN: $TOK" \
  "https://gitlab.lci.ge/api/v4/projects/24/pipeline" \
  --form ref=main --form "variables[][key]=RUN_SMOKE" --form "variables[][value]=1" \
  --form "variables[][key]=SCENARIO" --form "variables[][value]=all" \
  --form "variables[][key]=SOAK_MINUTES" --form "variables[][value]=15"
# poll .../pipelines/$P ; then pull the job artifact verdict.json:
#   .../jobs/$JOB/artifacts  → battle-artifacts/<run>/verdict.json
```
Check the nightly: Pipelines page filtered to source = Schedule, or `pipeline_schedules/1`. Artifacts (verdict.json + tool logs) retain 30 days.

## Reading a verdict

`verdict.json`: `{ run, soak_minutes, pass, invariants: { I1.., I4: {soak_writes, true_wipes, suspect_silent_drops, divergence_lww_or_business, pending_queue_at_end, true_wipe_detail[...] }, I7: {...} } }`.
- `pass:false` → find the failing invariant. For I4, check `suspect_silent_drops` first (real bug) vs `true_wipes` (likely harness if `suspect=0` — inspect `true_wipe_detail`: `cloud_now` holding the value = MCM08-class local clobber; both null = harder loss).
- **`soak_writes=0` = I4 verified NOTHING** (vacuous green) — see Gotcha: partition writers.

## Adding a new scenario (recipe)

1. Add a `case` in `battle/ci/run_scenario.sh` exporting the right chaos knobs.
2. If it needs a new invariant, add a `check_*()` in `observer/probe.py` and wire it in `main()` (mind ordering — I4 calls `/calm` + `quiesce_crew()` before judging; checks after it see a calmed, quiesced system).
3. If it needs new fault types, extend `chaos/chaos_api.py` (a POST route + a background loop honoring `/calm`).
4. **Make the invariant measure REAL tool behavior, not harness noise.** Before trusting a new gate, run it twice and confirm a clean run is green; a flapping/false gate is worse than none.
5. Keep `meta`/docs in sync; log to `FINDINGS.md` what the scenario stresses and any tuning.
6. Add the scenario to `ENGINEERING-REPORT.html`'s scenario table.

## Gotchas / lessons (hard-won — read before changing the harness)

- **Quiesce before judging.** Bots + mutator loop forever. The observer drops `RUNS_DIR/RUN_ID/STOP`; `crew/bot.mjs` and `cloud-mutator/mutate.sh` poll it and exit; `quiesce_crew()` waits, *then* snapshots. Skipping this makes `journaled` (snapshot) and `local` (read minutes later) incoherent → false wipes; and the queue never drains → I7 can't fire.
- **Partition IO ownership for long runs.** Bots write only `io.id % BOTS === botIndex`. Without it, over hours every IO becomes multi-writer, the observer excludes them all (ambiguous last-write), and **I4 checks 0 IOs — a vacuous green**. Single-writer = unambiguous last write = meaningful I4.
- **`journaled_results()` ordering:** use append-order within each bot journal (true write order), NOT string-compare on ISO `ts` (Failed+Cleared can tie at the same millisecond and mis-order → fake wipe). Exclude `hot` IOs and any IO touched by >1 bot.
- **I7 needs a drained ACTIVE queue.** The tool defers cloud pulls while it has active local work. *Active* = `PendingSyncs WHERE DeadLettered = 0` — parked rows must NOT count. **(Real bug found 2026-06-07, fixed:** the auto-pull gate counted ALL rows incl. parked, so a single SPARE-Passed parked row blocked cloud→field pulls forever — a v2.40.4 regression. Fixed in `frontend/lib/cloud/auto-sync.ts`; the observer's pending count now also filters `DeadLettered=0`.) I7 is precondition-aware: `inconclusive` (pass) if the active queue never drained, fails only on a real break. When debugging I7/queue, ALWAYS distinguish active vs parked — `pending` that "never drains" is usually parked-row inflation.
- **Retry-cap PARKS, not deletes** (tool v2.40.4): `DeadLettered=1`, kept for attention. The tool's `[AutoSync] DROPPING N rows…` log text is misleading (it parks) — don't let it trigger a false "data deleted" conclusion. The per-row `DROPPED/PARKED-PERMANENT ioId=… reason=…` lines are what the observer matches.
- **Image freshness.** CI builds observer/crew/chaos from the checked-out SHA each run; the heavy `tool`/`cloud`/`plc-sim` are *pulled* — if you changed tool code, rebuild+push those images first (`ci/build_and_push.sh`) or CI tests stale binaries.
- **Always `--build` / `--force-recreate`** locally; a bare `up -d` reuses stale containers.
- **Production is off-limits.** `cloud-stage` is throwaway; the prod DB is never connected. Verify prod (if ever needed) only read-only per the project's separate guidance.

## Key files

- `battle/observer/probe.py` — invariants + verdict
- `battle/crew/bot.mjs` — simulated technicians (partitioned writers, STOP sentinel)
- `battle/chaos/chaos_api.py` — fault injection (`/download`, `/power`, `/delay`, `/toolkill`, `/cloudcut`, `/calm`)
- `battle/cloud-mutator/mutate.sh` — cloud-side adds/edits
- `battle/seeder/seed.py` — seeds tool + cloud from the MCM02 copy
- `battle/ci/run_scenario.sh` — scenario driver (the CI entrypoint)
- `battle/ci/build_and_push.sh` — build+push heavy images from a disk-rich box
- `battle/docker-compose.battle.yml` — the stack
- `.gitlab-ci.yml` — `nightly-battle` (schedule) + `battle-smoke` (manual/RUN_SMOKE) jobs
- `battle/FINDINGS.md` — per-run engineering log (read for current state)
