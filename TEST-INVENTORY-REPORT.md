# Automated Test Inventory & Convergence Report

**Scope:** field tool (`frontend/`), commissioning-cloud, installation-tracker, and the battle chaos/soak rig (`frontend/../battle`).
**Date:** 2026-06-29. **Method:** read-only audit — package.json scripts, vitest configs, every test file, all three `.gitlab-ci.yml`, `battle/observer/probe.py`, `battle/ci/run_scenario.sh`, `battle/TEST-COVERAGE.md`, `battle/FINDINGS.md`. Counts are grep-verified, not estimated.

---

## 1. Executive summary

- **~888 automated unit/integration test cases across 93 test files**, all Vitest (node env), split: **field tool 570 cases / 59 files**, **cloud 248 / 25**, **tracker ~70-90 / 9**. Plus the **battle rig**: 10 chaos scenarios and **17 invariants (I1-I17)**, of which **9 gate** and **8 are report-only**.
- **What is gated in CI:** field-tool `npm test` is a HARD gate on every push/MR (`frontend-verify`); cloud `test` and tracker `lint/typecheck/test` are BLOCKING gates. All three have a `schema-guard` deploy gate. The battle **nightly** soak gates on I1-I5/I8/I9/I10 — but only for the scenarios in its weekday rotation.
- **Biggest gaps (detail in §6):** (1) **NO browser/E2E/UI tests anywhere** — Playwright is present in the field tool only for screenshots, never `@playwright/test`; (2) the **shipped Windows installer/EXE is never smoke-tested** (battle tests the Docker image only) — the single biggest field-risk gap; (3) **cloud→field CRUD/definition propagation (ADDRESSED, L2/FV, e-stop, network) is unit-proven but its live battle gate (I14-I17) is REPORT-ONLY and has never run a soak**; (4) **the site topology (`central-cdw5-split`, `PLC_MODE=remote`) and `crud-propagation` never run in the nightly rotation**; (5) **version-conflict / optimistic-lock resolution (the PendingSync deadlock class) has no cloud test**; (6) **auth/authz untested in all three repos** (field tool only guards the auth-OFF default).
- **Convergence verdict (the point of this report):** every data type synced both directions now has **some** unit coverage — the 2026-06-27 coverage-keeper sweep closed the unit-level holes. But for the cloud→field definition/CRUD types the **live, in-CI integration gate does not yet exist** (REPORT-ONLY invariants, never soaked). So coverage is *converging on the merge logic* but **not yet on real end-to-end behavior** for ADDRESSED / L2-FV / e-stop / network propagation.

---

## 2. Per-repo inventory

### 2.1 Field tool — `frontend/` (Express 5 + better-sqlite3 + libplctag/ffi-rs + cloud sync)

- **Runner:** Vitest 4.1.0, node env. Config `frontend/vitest.config.ts`: `include: ['__tests__/**/*.test.ts']`, `globals: true`, `testTimeout: 10000`, `@`→repo root. No setup file; tests build SQLite in-memory/temp via `__tests__/helpers.ts`.
- **Files:** **59** test files, all `frontend/__tests__/*.test.ts`. No `.tsx`, no `.spec.ts`.
- **Cases:** `it(` 564 + `test(` 6 = **570** (describe blocks 142). The CI comment's "503 tests" is stale.
- **Scripts:** `test` = `vitest run` (CI gate); `test:watch`. The `test:plc*` and `seed:*` scripts are standalone **`tsx` hardware/seed tools** (e.g. `test-plc.ts` connects to a real PLC IP, `test-network-poll.ts` defaults `PLC_IP=192.168.20.40`) — excluded from the vitest glob, **never in CI**.
- **Coverage by area (strong):** sync push/pull/delta (delta-sync, sync-cursor, sync-version, sync-retry-cap, pending-sync-deadletter, result-reconciler, remote-cache, cloud-sse-*), data-safety/no-loss (data-safety, concurrency-soak, pull-guard, pull-block-estop-guided, l2-pending-sync-deadletter, backup-retention, recovery-log, log-retention), PLC (plc-client, identity-parse, dlr, gateway-client, network-poller-parser, connection-verdict), L2/FV, e-stop, network, firmware, VFD (7 files), guided/roadmap workflow (9 files).
- **Gaps:** **UI — zero** (node env, no `.tsx`, no React Testing Library; the IO grid `enhanced-io-data-grid.tsx` is untested). **Real authz — none** (auth-middleware-express + auth-routes only assert the *auth-OFF* default — anon-admin regression guards). **Schema contract — thin** (3 files) despite SQLite auto-migrate being a stated risk.
- **E2E:** none. Playwright is a devDep used only by `scripts/take-screenshots.ts`, `record-guide-gifs.ts`, etc. No `@playwright/test`, no `playwright.config`.

### 2.2 Cloud — `commissioning-cloud` (Next.js 14 sync API + dashboard)

- **Runner:** Vitest 3.2.4, node env, `@vitest/coverage-v8`. Config `vitest.config.ts`: `include: tests/**/*.test.ts`, coverage scoped to `lib/**/*.ts`, "unit only — no network, no Postgres".
- **Files:** **25** in `tests/`. (A stale 24-file copy under `.claude/worktrees/delta-sync/tests/` is a git worktree — NOT run by CI, excluded.)
- **Cases:** `it(`/`test(` = **248** (69 describes). `assistant-eval.test.ts` is `describe.skipIf(!isAiEnabled())` → **skipped in CI** (no GEMINI key).
- **Scripts:** `test` = `vitest run`; `test:ci` = `vitest run --coverage` (CI gate); `test:eval` = manual live-Gemini eval.
- **Coverage:** sync delta/pull (delta.test.ts cursor+tombstones, change-log.test.ts), push contract (validations.test.ts PascalCase↔camelCase C#↔web), data-safety (sync-comment-history clobber-ledger, reports-variants customer redaction), multi-MCM (belt-tracking-resolve-subsystem device→subsystem fan-out), L2 import (l2.test.ts), blockers/party/triage, belt-tracking/VFD, reports, notifications, IO-grid filters, install-resolution, assistant SQL-safety.
- **Gaps (no coverage):** **version-conflict / optimistic-lock** (the exact-version → dead-letter deadlock class) — NONE; **e-stop** NONE; **firmware** NONE; **network/NET** NONE; **auth/authz** (NextAuth, Azure AD, admin-group, API-key on sync endpoints) NONE; **Prisma schema** (guarded by schema-guard checksum, not tests); **HTTP route handlers / DB integration** none by design (Prisma stubbed).

### 2.3 Installation-tracker — `installation-tracker` (Next.js 16, Prisma 7, shared Postgres)

- **Runner:** Vitest 3, node env. Config `vitest.config.ts`: `include: src/**/*.{test,spec}.ts`, coverage opt-in scoped to `src/lib/**`.
- **Files:** **9** (all `src/lib/**`). Note two `blockers.test.ts` (one in `src/lib/`, one in `src/lib/__tests__/`) — both run, partial overlap.
- **Cases:** **69** `it`/`test` (22 describes); a few `it.each` expand higher → realistic **~70-90**.
- **Scripts:** `test` / `test:watch` / `test:ci` (= `vitest run --coverage`, CI gate).
- **Coverage:** strongest on the **install-progress data model** (cellUpdateService percent-complete + TABLE_CONFIG weight integrity + write whitelist, dashboardService slug maps, gapReportService aggregation/CSV), importers (mcmParser, powerDistributionParser), **shared Devices.Blocker\* contract** (party whitelist, both-or-neither, isBlocked — *local validation only, not the cross-app write*), and access-key role normalization.
- **Gaps (no coverage):** API route handlers; Prisma schema; NextAuth/Azure AD flow + route guards/`verifyAuth`/RBAC; the actual cross-app `Devices.Blocker*` sync write; the entire React UI.
- **E2E:** none.

### CI gate summary (all GitLab; GitHub is mirror only)

| Repo | Test job | Blocking? | Lint/Typecheck | Schema gate | Deploy |
|---|---|---|---|---|---|
| Field tool | `frontend-verify` → `npm test` (vitest, plain node) | **HARD gate** (every push/MR) | advisory (echo, non-blocking) | — (SQLite auto-migrate) | n/a (GitHub releases) |
| Cloud | `test` → `npm run test:ci` | **BLOCKING** | advisory (`allow_failure: true`) | `schema-guard` sha256 baseline, blocks deploy | build→deploy SSH + health + auto-rollback |
| Tracker | `test` → `npm run test:ci` | **BLOCKING** | **BLOCKING** (lint+typecheck) | `schema-guard` git-diff, blocks deploy | build→deploy SSH + health + auto-rollback |

Field-tool battle pipelines (same root `.gitlab-ci.yml`): `nightly-battle` (schedule, 9h timeout, weekday-rotated scenario), `battle-smoke` (manual/web, s2 15min — release gate), `battle-delta` (manual/`DELTA=1`), `central-battle` (`CENTRAL=1`, runs `central-cdw5-split` 60min). Heavy `tool`/`plc-sim` images auto-built on merge→main (`build-tool-image`); `cloud:latest` staged by `refresh-cloud-image`.

---

## 3. Battle rig — scenarios & invariants

### Scenarios (`battle/ci/run_scenario.sh`)

| Key | Throws | Topology | In nightly rotation? |
|---|---|---|---|
| `s1` | clean scale soak | single-MCM | no |
| `s2` | PLC program-download storm | single-MCM | **Mon** + battle-smoke |
| `s3` | cloud connectivity flap | single-MCM | **Tue, Fri** |
| `s6` | CIP-saturated controller | single-MCM | **Sat** |
| `mutate` | cloud-side edits/additions | single-MCM | **Thu** |
| `central` | 4 registry MCMs + SSE + flap + FV/L2 writes | central, embedded | **Wed, Sun** |
| `central-cdw5` | 19 real CDW5 MCMs | central, embedded | no (manual) |
| `central-cdw5-split` | 19 MCMs, `PLC_MODE=remote` + gateway | **THE SITE TOPOLOGY** | no — only via `CENTRAL=1` |
| `central-cdw5-live` | real emulator controllers | central, remote, real PLC | no (manual) |
| `delta` | cloud→field delta via recorded admin API | single-MCM | no — only via `DELTA=1` |
| `crud-propagation` | cloud-side CRUD: ADDRESSED, L2/FV, e-stop, network | single/multi-MCM | **no — never wired into rotation; never soaked** |
| `all` | everything at once | single-MCM | no (manual nightly option) |

### Invariants (`battle/observer/probe.py`)

| ID | Asserts | GATE / report | Runs when |
|---|---|---|---|
| **I1** responsiveness | `/api/health` p95<500ms, p99<2000ms, no gap>10s (post-warmup) | **GATE** | always |
| **I2** no memory leak | RSS slope <5 MB/h after warmup; gates only on a long settled window | **GATE** | always (long runs) |
| **I3** flag/VFD/polarity restore | every chaos `download` followed by flag/VFD validation restore | **GATE** | download scenarios |
| **I4** no data loss | local SQLite is authority; journal survives; `suspect_silent_drops`==0 (excludes business-rejected + cloud-mutator divergence) | **GATE** | when cloud attached |
| **I5** stability | unexpected `server.start` events==0; PLC-flap within budget | **GATE** | always |
| **I7** cloud→field propagation | new cloud IOs reach the field | **report-only** | mutate scenario |
| **I8** SSE live-channel auth | gates only on deterministic 401/403 auth rejection (the MCM11 "Red") | **GATE** | when cloud attached |
| **I9** bounded auto-backups | backup dir stays within `BACKUP_RETENTION_KEEP` (the 4 GB incident) | **GATE** | always |
| **I10** per-MCM isolation | every MCM has own IOs (non-vacuous) AND zero NULL-SubsystemId L2/network rows (cross-MCM leak) | **GATE** | central/multi-MCM |
| **I11** delta-propagation | cloud-added IOs (recorded admin API) converge locally | report-only | delta |
| **I12** delete-propagation | cloud-deleted IOs removed locally | report-only | delta |
| **I13** cold-start cursor | `SyncCursors.LastSeq` advances | report-only | delta |
| **I14** VFD ADDRESSED propagation | cloud ADDRESSED mark reaches field `VfdAddressed`; other MCMs untouched | **report-only — never soaked** | crud-propagation |
| **I15** L2/FV cell propagation | field `L2CellValues` converges to cloud value+version; older cloud echo never clobbers newer local (LWW) | **report-only — never soaked** | crud-propagation |
| **I16** e-stop-def propagation | field `EStopZones` converges; other MCMs' zones NOT wiped (legacy global `pull-estop` does `DELETE FROM EStopZones`) | **report-only — never soaked** | crud-propagation |
| **I17** network propagation | field `NetworkRings/Nodes/Ports` converge; no orphan ports; no cross-MCM wipe | **report-only — never soaked** | crud-propagation |

Gate logic (probe.py): `REPORT_ONLY = {I7,I11,I12,I13,I14,I15,I16,I17}`; `pass = all gating invariants pass`. Report-only invariants are written to `verdict.json` but never affect the exit code. I14-I17 were authored 2026-06-27 **on a machine with no Docker — never run** (FINDINGS.md), and require a multi-MCM run to observe the cross-MCM-wipe cases.

Chaos primitives (`chaos/chaos_api.py`): `download`, `power`, `delay`, `toolkill`, `cloudcut`, `calm`. Crew bots write IO Pass/Fail/Cleared (SPARE-aware, single-writer-partitioned) + FV/L2 cells per MCM — **bots write cells directly, NOT through the VFD wizard UI** (the rig is blind to the UI).

---

## 4. Convergence matrix — every synced data type × coverage surface × in-CI

Legend: ✅ covered · 🟡 partial/vacuous · ❌ gap. "In-CI gate?" = does a *blocking* CI job exercise it.

| Data type / behavior | Direction | Unit test (file) | Battle scenario + invariant | In-CI gate? |
|---|---|---|---|---|
| **IO pass/fail + comments** | both | ✅ field: data-safety, sync-*, concurrency-soak, result-reconciler; cloud: validations, sync-comment-history | ✅ s1/s2/central + **I4** (gate), I7/I11/I12 (report) | ✅ unit gated both repos; ✅ I4 gates nightly |
| **IO add/delete (CRUD)** | cloud→field | ✅ field: delta-sync, cloud-sse-*; cloud: delta, change-log | 🟡 I11/I12 (delta scenario) **report-only**, not in rotation | 🟡 unit gated; live NOT gated |
| **L2 / FV cells** | both | ✅ field: l2-fv-sync-coverage, l2-subsystem-scoping, l2-pending-sync-deadletter; cloud: l2 | 🟡 central writes FV/L2; **I15 report-only, never soaked**; multi-MCM L2 drain-to-cloud not seeded | 🟡 unit gated; live NOT gated |
| **VFD ADDRESSED / blockers** | cloud→field | ✅ field: vfd-addressed-sync, device-blocker-sync, vfd-blockers; cloud: device-blocker-resolution, blockers, api-blocker | ❌ **I14 report-only, never soaked** (proven only MANUALLY 2026-06-27) | 🟡 unit gated; live NOT gated |
| **E-stop definitions** | cloud→field | ✅ field: estop-sync-coverage, estop-check-sync, estop-status-subsystem-filter | ❌ **I16 report-only, never soaked**; cross-MCM global-wipe risk ungated | 🟡 unit gated; live NOT gated. **Cloud: no e-stop test at all** |
| **Network topology** | cloud→field | ✅ field: network-sync-coverage, network-poller-parser, network-rack-slot-exclusion | ❌ **I17 report-only, never soaked**; seed has `network=0` per-MCM | 🟡 unit gated; live NOT gated. **Cloud: no network test** |
| **Firmware baseline** | cloud→field | ✅ field: firmware-sync-coverage, firmware-compliance | ❌ no battle scenario (field→cloud fw is live-PLC, hardware-only) | 🟡 unit gated; live n/a. **Cloud: no firmware test** |
| **Punchlist / ADDRESSED-Clarification** | both | 🟡 partial — folded into vfd-addressed/device-blocker on field; cloud blockers/api-blocker | ❌ same I14 report-only path | 🟡 unit-ish; live NOT gated |
| **Version-conflict / optimistic-lock** | field→cloud | ✅ field: sync-version, sync-retry-cap, pending-sync-deadletter | 🟡 I4 catches loss, not conflict semantics | 🟡 field gated; **cloud: NO conflict test** |
| **Per-MCM data isolation** | central | 🟡 field: l2-subsystem-scoping, estop-status-subsystem-filter | ✅ **I10 gate** (central); but network/e-stop per-MCM not seeded | ✅ I10 gates `central` nightly (Wed/Sun) |
| **Auth / authz** | all | ❌ field only guards auth-OFF; cloud none; tracker only access-key role-normalize | ❌ all runs anon-admin | ❌ NOT gated anywhere |
| **Schema / migration** | all | 🟡 field: 3 thin contract files; cloud/tracker: none | ❌ schema-migration-on-upgrade untested | 🟡 schema-guard (checksum/diff) gates deploy, not behavior |
| **Shared Devices.Blocker\*** | cross-app | ✅ tracker: blockers ×2; cloud: blockers/party; field: device-blocker-sync | ❌ no cross-app integration test | 🟡 each side's local validation gated; the actual shared-column write NOT |
| **UI (IO grid, dashboards, wizard)** | — | ❌ none anywhere | ❌ rig drives API, blind to UI | ❌ NOT gated |

**Reading the matrix:** the diagonal of *unit* coverage is now essentially complete (the 2026-06-27 sweep added the five `*-sync-coverage.test.ts` files). The systematic hole is the **"live, in-CI" column** for the four cloud→field CRUD/definition types (ADDRESSED, L2/FV, e-stop, network): their battle invariants I14-I17 exist but are **report-only and have never run a soak**, and the `crud-propagation` scenario is not in the nightly rotation. On the **cloud** side, e-stop / network / firmware / version-conflict / auth have **no unit test at all** — the cloud suite is dashboard/reports/belt-tracking-heavy and light on the sync-contract edges.

---

## 5. Browser / E2E opportunity assessment

**Current state:** zero browser/E2E across all four repos. No Playwright `@playwright/test`, no Cypress, no Selenium specs or configs. The field tool has `playwright` only for screenshot/GIF scripts. The battle rig drives the **HTTP API directly** and is explicitly "blind" to the UI — so UI regressions (e.g. the central per-MCM wiring bug where MCM01 showed MCM02 data, fixed v2.42.1) are invisible to every automated layer today.

**Where E2E pays off most (ranked):**

1. **Cloud dashboard (commissioning-cloud) — highest value.** It is a real Next.js web app on a stable URL, multi-user, and the surface where coordinators act on data (IO grid NET/Install columns, belt-tracking/VFD page, blocker triage ⋯ control, ADDRESSED/Clarification inline grid, reports export). High-value journeys:
   - IO-grid loads for a project/MCM, filters by party/blocked, Install + NET columns render (NET gray when no field tool).
   - Belt-tracking page shows BLOCKED pill + inline reason; mark a VFD blocker ADDRESSED → row updates.
   - Blocker triage: set party → description → comment, persists.
   - Report export: internal→customer redaction actually strips tester names/reasons (already unit-tested in reports-variants — an E2E would prove the rendered download).
2. **Field tool UI (frontend) — high value but harder.** Electron/Express+Vite app needing a PLC sim and a seeded SQLite DB. The per-MCM wiring class of bug (route param vs singleton plcConfig) is *exactly* what an E2E catches and unit tests miss. Best run against the existing battle `tool` container + `plc-sim`, driving Chromium at the Vite UI. Journeys: open MCM01 → confirm its own IO/L2/e-stop data (not MCM02's); run a VFD wizard step → cell + PLC tag write; e-stop check flow.
3. **Installation-tracker — lower priority.** Smaller blast radius; data-model logic already the best-unit-tested of the three.

**Minimal recommended setup (do NOT build yet — recommendation only):**
- **Playwright Test** (`@playwright/test`), one config per web app (cloud first). It already records **video** (`use: { video: 'retain-on-failure' }`), **screenshots** (`screenshot: 'only-on-failure'`), and **traces** (`trace: 'on-first-retry'`) as artifacts — exactly the "videos + screenshots-on-failure" ask, no extra tooling.
- **Cloud:** add a `e2e:` GitLab job in the `verify` stage, `allow_failure: true` at first (advisory, like lint/typecheck were), running Playwright against the built Next.js app with a seeded throwaway Postgres (or a read-only snapshot). Upload `playwright-report/` + `test-results/` as `artifacts` (the battle pipeline already uses `artifacts: when: always`).
- **Field tool:** reuse the battle `docker-compose.battle.yml` stack (tool + plc-sim + cloud-stage already wired) and point Playwright at the tool's web port; a new `battle`-stage `ui-e2e` job. This piggybacks on infra that already exists.
- **Agent-driven:** the repo already ships an `ecc:e2e-runner` agent and a `vercel:verification` skill; a Playwright harness gives those agents real browser journeys to drive and artifacts to attach.
- **Start small:** 3-5 cloud journeys behind `allow_failure: true`, promote to blocking once green twice (the same "report-only → gate after 2 green soaks" rule the battle rig uses for invariants).

---

## 6. Prioritized gap list (cheapest/highest-value first)

1. **Wire `crud-propagation` into the battle nightly and promote I14-I17 to gating once green ×2.** *(Cheapest high-value — the scenario + invariants are already written, just never run.)* Closes the live cloud→field gate for ADDRESSED / L2-FV / e-stop / network. Requires a multi-MCM run to observe the cross-MCM-wipe cases (I16/I17) and a cloud-stage seeded with per-MCM L2/e-stop/network rows. Until then these are unit-proven only.
2. **Add the site topology to the routine gate.** `central-cdw5-split` (`PLC_MODE=remote` + gateway — what the site actually runs) is only triggered manually via `CENTRAL=1`; the nightly rotation never exercises remote/gateway mode. Add it to a weekly slot.
3. **Cloud: add the missing sync-contract unit tests** — version-conflict / optimistic-lock resolution (the PendingSync exact-version dead-letter deadlock), plus e-stop, network, and firmware pull endpoints. The cloud suite is the field tool's sync counterpart yet tests none of these edges. Cheap (pure-logic, Prisma already stubbed in-suite).
4. **Built-artifact smoke test (BLOCKER per `battle/TEST-COVERAGE.md`).** Battle tests the Docker image, never the Windows installer/portable ZIP — so the `vcruntime140.dll`/`plctag.dll` "os error 126" class, fresh-install boot, and upgrade-over-existing-with-schema-migration are all untested on the shipped binary. Highest field risk; not cheap, but the single biggest gap.
5. **First Playwright E2E suite on the cloud dashboard** (§5) behind `allow_failure: true`, with video/screenshot/trace artifacts. Catches the UI-wiring bug class that the API-blind battle rig and node-env unit suites both miss.
6. **Polarity-specific writeback gate** — assert `Normal_Polarity`/`Reverse_Polarity` (not just generic "VFD validation") is re-written after every PLC download (the belt-reversal/VFD-damage path); today I3 is generic.
7. **Auth-enabled run / authz tests** once the central-tool auth is turned on — every test and battle run today is anon-admin; no repo tests a real role gate.
8. **Schema-migration-on-upgrade, backup-restore, disk-full degrade, multi-day-outage drain, handle-leak long soak** — the longevity/upgrade cluster from `TEST-COVERAGE.md` Part 3, none gated today.
9. **Cross-app `Devices.Blocker*` contract test** — each repo validates its own blocker vocabulary locally, but nothing tests that the field-tool/cloud/tracker writes agree on the same shared columns end-to-end.

### Honest notes on vacuous / thin coverage
- Field-tool **auth tests guard the auth-OFF default** — they prove auth is disabled, not that any authz works. Not coverage of a security model.
- Cloud **`assistant-eval.test.ts` is skipped in CI** (no GEMINI key) — present but contributes zero automated assurance in the pipeline.
- **I14-I17 currently always pass vacuously** on single-MCM / no-op runs and have never executed a real soak — do not read a green `verdict.json` as evidence they work until soaked.
- **schema-guard is a checksum/diff gate, not a test** — it blocks an *unblessed* schema change from deploying; it proves nothing about migration behavior or data preservation.
- **I2 (memory) and I1 (responsiveness) only gate on a sufficiently long/settled window** — a short smoke run can pass them without meaningfully exercising the leak/latency check.
