# battle/e2e — Playwright browser E2E for the connected stack

Browser end-to-end tests that drive **both** UIs in the battle rig and assert
they stay in sync:

- **field tool** (Express + Vite React) — `http://localhost:13000`
- **cloud dashboard** (commissioning-cloud, Next.js) — `http://localhost:13001`

The headline journey marks an IO **Failed** in the field tool and asserts the
result propagates to the cloud (the apps are connected via the real sync path).

> This is a **runnable foundation**, not a finished green suite. Several selectors
> are marked `TODO(confirm-on-live)` in the specs — they encode the correct
> structure but must be confirmed against a live stack in a fix-loop. See
> [Selectors / assumptions to confirm](#selectors--assumptions-to-confirm).

## Layout

| File | What |
|---|---|
| `playwright.config.ts` | video=on, screenshot=only-on-failure, trace=on-first-retry; html+json reporters; artifacts under `battle-artifacts/e2e/`; base URLs from env |
| `tests/helpers.ts` | field-tool helpers (name-prompt bypass, locate IO row, start testing, Fail/Clear) + contract constants |
| `tests/cloud-dashboard.spec.ts` | cloud dashboard smoke (home, project detail grid, navigation, public sync API) |
| `tests/connected-propagation.spec.ts` | **the headline** — field Fail → cloud propagation |
| `ci-snippet.yml` | draft GitLab job (do NOT paste into the real `.gitlab-ci.yml` unreviewed) |

## Prerequisites

- Node 20+ and the battle stack's Docker requirements (see `../README.md`).
- The connected stack must be **up** before running the suite (the tests do not
  start it for you — that is validated separately on the live runner).

## 1. Bring up the connected battle stack

From the repo root (or `battle/`):

```powershell
# minimal connected stack (no long soak, no bots) is enough for E2E:
$env:RUN_ID = "e2e-$(Get-Date -Format yyyyMMdd-HHmm)"
docker compose -f battle/docker-compose.battle.yml -p battle up -d `
  seeder cloud-db cloud-schema cloud-seed cloud plc-sim tool
```

This publishes the UIs on the host:

- field tool → <http://localhost:13000>
- cloud dashboard → <http://localhost:13001>

### Unlock the cloud dashboard UI (optional but recommended)

By default the battle cloud runs `NODE_ENV=production`, so its dashboard routes
(`/`, `/project/[id]/...`) are behind a NextAuth login and **redirect to
`/auth/signin`**. The `/api/sync/*` API stays public (X-API-Key) — that is how
the field tool and the propagation check read cloud state regardless.

To exercise the **full cloud UI journey**, bring the cloud up with the dev auth
bypass:

```powershell
$env:CLOUD_NODE_ENV = "development"   # → cloud service NODE_ENV
$env:CLOUD_DEV_BYPASS = "1"           # → cloud service DEV_BYPASS_AUTH
docker compose -f battle/docker-compose.battle.yml -p battle up -d `
  seeder cloud-db cloud-schema cloud-seed cloud plc-sim tool
```

Without it, the cloud-UI assertions `test.skip()` themselves with a clear note,
and propagation is still verified via the public sync read.

## 2. Install browsers (one-time)

```bash
cd battle/e2e
npm install                 # installs @playwright/test
npm run install:browsers    # playwright install --with-deps chromium
```

> The scaffold step did **not** install browsers. `npx playwright test --list`
> works without them; actually running tests needs the Chromium download above.

## 3. Run

```bash
cd battle/e2e

# against the published host ports (defaults):
npm run test:e2e

# or point at any host/network (e.g. inside CI on the battle docker network):
TOOL_URL=http://tool:3000 CLOUD_URL=http://cloud:3000 npm run test:e2e

# list without running (no browsers needed) — quick parse/compile check:
npm run test:e2e:list

# headed / interactive:
npm run test:e2e:headed
npm run test:e2e:ui
```

### Env knobs

| Var | Default | Purpose |
|---|---|---|
| `TOOL_URL` | `http://localhost:13000` | field-tool base URL |
| `CLOUD_URL` | `http://localhost:13001` | cloud dashboard base URL |
| `CLOUD_API_KEY` | `battle-key-mcm02` | project API key for the public `/api/sync` read |
| `E2E_SUBSYSTEM_ID` | `38` | seeded subsystem (MCM02) |
| `E2E_TESTER_NAME` | `Playwright E2E` | operator name seeded into the field tool |
| `E2E_ARTIFACT_DIR` | `../../battle-artifacts/e2e` | where reports/video/traces land |

## 4. Artifacts

Everything lands under `battle-artifacts/e2e/` so the existing GitLab
`artifacts: paths: [battle-artifacts/]` rule (`.gitlab-ci.yml` `.battle-base`)
already collects it:

- `battle-artifacts/e2e/html-report/` — open with `npm run report`
- `battle-artifacts/e2e/results.json` — machine-readable
- `battle-artifacts/e2e/test-results/` — per-test **video** (always), **screenshots**
  (on failure), **traces** (on first retry). View a trace with
  `npx playwright show-trace <path-to-trace.zip>`.

## Why Fail and not Pass?

The field tool has **no Pass button** — a Pass is produced by a live PLC
TRUE-edge while testing is active (a dialog then confirms it). **Fail** is a
deterministic icon-button click once testing is started, so the UI-driven
mutation in the propagation spec uses Fail. (A Pass-path journey would need to
drive the plc-sim to toggle a tag, which is a later enhancement.)

Note also: if the stack runs with the per-machine `requireInstalledForTesting`
policy on, or the target IO's parent network device is faulted, the Fail button
is disabled. The MCM02 seed with the sim up should allow a plain IO to be
failed; if Fail is disabled on a live run, pick a different IO or check that
policy.

## Selectors / assumptions to confirm

These are encoded correctly-by-structure but **must be confirmed on a live run**
(grep the specs for `TODO(confirm-on-live)`):

1. **Field-tool IO row** — `tests/helpers.ts` `ioRow()` assumes each virtual row
   wrapper carries `data-index` and contains the IO name. Confirm it resolves to
   the row carrying `row-passed/row-failed` + the Fail/Clear buttons.
2. **Fail-comment dialog submit** — the propagation spec clicks a
   `Save|Confirm|Submit|OK` button if a `role=dialog` appears after Fail. Confirm
   the actual `FailCommentDialog` submit label.
3. **Cloud pull payload result field** — `cloudResults()` reads `io.result` from
   `GET /api/sync/subsystem/{id}`. Confirm the field name and array shape.
4. **Cloud grid row/result selector** — the cloud-UI assertion currently just
   checks the IO name is visible on `/project/1/detail`. Tighten to the specific
   row's "Failed" badge once the (virtualised) cloud grid row selector is
   confirmed.
5. **Cloud "Open" button** — the navigation spec clicks a `role=button name=open`
   on a project card; confirm vs. clicking the card heading link.

## Next step to validate live

```bash
# 1. up (with cloud UI unlocked)
CLOUD_NODE_ENV=development CLOUD_DEV_BYPASS=1 \
  docker compose -f battle/docker-compose.battle.yml -p battle up -d \
  seeder cloud-db cloud-schema cloud-seed cloud plc-sim tool

# 2. browsers + run, watching the trace/video on the first failures
cd battle/e2e && npm install && npm run install:browsers
npm run test:e2e

# 3. fix the TODO(confirm-on-live) selectors against the html-report + traces,
#    re-run until green, then promote the CI job off allow_failure.
```

## CI

See `ci-snippet.yml` — a draft `e2e-playwright` job that extends the existing
`.battle-base`, brings the stack up, runs Playwright from
`mcr.microsoft.com/playwright` on the battle docker network, and exports
`battle-artifacts/e2e/`. It is `allow_failure: true` and **manual** initially;
promote to a gate after the live fix-loop.
