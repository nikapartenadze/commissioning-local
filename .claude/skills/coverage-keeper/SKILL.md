---
name: coverage-keeper
description: Use after adding or changing a feature in the field tool (frontend/), commissioning-cloud, or installation-tracker — before merging — to bring the tests up to the new behavior. Use when a change touches sync, data-safety, PLC, multi-MCM, L2/FV, e-stop, auth, cloud-API, or prisma schema contracts; when you added a feature and aren't sure which test surface should cover it; or when CI/battle coverage feels out of step with what shipped.
---

# coverage-keeper

## Overview

Three apps, three test surfaces, one rule: **a behavior is not covered until something automated fails when it breaks.** This skill maps a feature change to the *right* surface — a unit test, a battle scenario+invariant, a schema-guard re-bless, or an honest "this needs hardware/manual" note — and refuses to let a change land claiming coverage it doesn't have.

The trap this exists to stop: adding a vitest test for the easy logic, feeling done, and silently leaving a sync/multi-MCM/PLC contract uncovered by the battle rig — exactly the class that caused the field incidents (MCM08 wipe, MCM11 429-drop, the parked-row pull deadlock).

## When to use

Run this on your feature branch, after the feature works, before you merge/push. Run it once per repo the change touched.

## Step 1 — Scope the change

```sh
git diff --stat main...HEAD        # which files, which repo(s)
git diff main...HEAD               # read the actual behavior change
```

A change can span repos (sync contracts touch both `frontend/` and `commissioning-cloud/`; shared project/IO data touches `installation-tracker/`). Run the skill for each repo with edits. The three repos are **separate git repos** — `commissioning-cloud/` and `installation-tracker/` are siblings of this workspace, not nested.

## Step 2 — Classify by contract, pick the surface

For every changed file, find the row that fits the *deepest* contract it touches (a file can hit several — take the strongest action listed).

| Contract touched | Surface that must cover it | Action |
|---|---|---|
| Pure logic — parser, classifier, reducer, validator, formatter, util | **Unit test** in that repo | Add/extend a `*.test.ts`. Almost always required. |
| Sync / offline-queue / retry-cap / version-conflict / data-loss | Unit test **+ battle** (local) | Unit-test the classification; then Step 4. This is the incident class — do not skip battle. |
| Multi-MCM isolation / per-MCM connection / scoped pull | Unit test **+ battle central** | Step 4 — `central` scenario / per-MCM invariant. |
| PLC read/write, polarity/Valid_* writeback, reconnect restore | Unit test **+ battle**; **hardware note** | Unit-test the logic; battle covers restore (I3). The *real-CIP write* is hardware-only — say so. |
| L2 / FV cell writes, propagation, cloud→field delta | Unit test **+ battle** (`mutate`/`delta`) | Step 4. |
| E-stop / safety / firmware verdict logic | Unit test | Battle has no gate yet (see TEST-COVERAGE.md gaps) — note it. |
| Auth / API key / route guard | Unit test (both repos as relevant) | |
| **`prisma/schema.prisma`** (cloud or tracker) | **Schema-guard** | Step 5 — this BLOCKS deploy if mishandled. |
| Installer / NSIS / portable build / dll bundling | **Manual** | No automated gate exists. State plainly it ships untested by CI. |

## Step 3 — Write/extend the unit tests

| Repo | Tests live in | Run |
|---|---|---|
| `frontend/` (field tool) | `frontend/__tests__/*.test.ts` (vitest, 56 files) | `cd frontend && npm test` |
| `commissioning-cloud/` | `tests/**/*.test.ts` (vitest) | `npm test` (CI: `npm run test:ci`, coverage) |
| `installation-tracker/` | `src/**/*.{test,spec}.ts` (vitest) | `npm test` |

Match the existing file's style; pick the nearest neighbor test as a template (e.g. sync change → `sync-retry-cap.test.ts` / `result-reconciler.test.ts`; PLC → `plc-client.test.ts`; guided → `guided-*.test.ts`). Tests are **pure** — node env, no DB, no network. If the behavior can only be exercised with a live DB/PLC/cloud, it does **not** belong in unit tests — it belongs in battle (Step 4) or is a documented manual check.

## Step 4 — Battle coverage (field tool only)

**REQUIRED BACKGROUND:** load the `battle-test` skill before editing anything under `battle/`.

For sync / data-safety / multi-MCM / PLC-restore / propagation changes, decide:

1. **Is the failure mode already gated?** Read `battle/TEST-COVERAGE.md` (the coverage matrix) and the incident→coverage matrix in `battle/FINDINGS.md`. If an existing invariant (I1–I13) already catches a regression of this behavior, you're done — note which one.
2. **New failure mode?** Then it needs a scenario that *reaches* it (`battle/ci/run_scenario.sh`) and an invariant that *catches* it (`battle/observer/probe.py`). Per `battle-test` skill rule #4: a new gate must be proven green on a clean run **twice** before it gates — add it report-only first.
3. **Always** update `battle/TEST-COVERAGE.md`: move the row from a gap to covered, or add the new gap honestly. If it maps to a real incident, add a row to the incident→coverage matrix in `FINDINGS.md`.
4. **Image freshness:** battle CI *pulls* the `tool` image — a battle test only exercises your change once the image is rebuilt+pushed (`battle/ci/build_and_push.sh`). Note that the new coverage is pending image push.

Do **not** invent a battle gate for pure-logic changes — a unit test is the right, cheaper surface. Battle is for behavior that only emerges under real image + data + chaos + duration.

## Step 5 — Schema-guard (cloud / tracker, only if schema.prisma changed)

These repos block auto-deploy when `prisma/schema.prisma` drifts from the blessed hash, because the Postgres is **shared** and migrations are manual (`prisma db push`, no migration files).

After the migration is applied to the live DB:
```sh
sha256sum prisma/schema.prisma | cut -d' ' -f1 > prisma/schema.prisma.sha256
```
in the **same commit** as the schema change (or set CI var `SCHEMA_CHANGE_APPROVED=1`). If you can't apply the migration yet, say so — do not re-bless a hash for a migration that hasn't run.

## Step 6 — Verify, then report honestly

Run the suite(s) for every repo you touched and confirm **green** before claiming anything (`npm test`; `npm run lint`; typecheck with `tsc --noEmit`). Then report in three buckets:

- **Now covered (automated):** the tests/invariants that will fail if this regresses.
- **Pending:** battle coverage authored but waiting on an image push / a second green run before it gates.
- **NOT covered by CI (manual/hardware):** real-PLC writeback, installer/EXE smoke, real-drive STS latch, anything you couldn't gate. Name it — silence here reads as "covered" and that is how incidents ship.

## Red flags — you are under-covering

- "I added a vitest test, done" — but the diff touched a **sync/multi-MCM/PLC** contract and you never opened `battle/TEST-COVERAGE.md`.
- "The logic is simple" — simple sync logic is exactly what dropped 818 results (MCM08) and silently 429-dropped writes (MCM11).
- Editing `schema.prisma` without touching `schema.prisma.sha256` — the deploy will block, or worse, drift.
- Claiming "fully covered" when the only real exercise is a live PLC or the Windows installer. Those have **no** automated gate. Say it.
- Adding a new battle invariant and trusting it on one run — flapping gates are worse than none; prove it green twice (report-only first).

## What this skill does NOT do

It doesn't run multi-hour soaks (trigger those via the `battle-test` skill / nightly CI) and it doesn't test the shipped installer (no automated gate exists — the standing biggest gap in `battle/TEST-COVERAGE.md`). It gets the *fast* surfaces right and tells the truth about the slow/manual ones.
