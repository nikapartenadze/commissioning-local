# Guided Mode (SVG-driven) — Design

**Status:** approved (sections 1–4) on 2026-04-28, pending spec review
**Branch:** `interactive-svg-checkout`
**Scope:** local field tool only for the v1 build

## 1. Context & motivation

The IO Checkout Tool currently lets electricians test IOs in any order from a spreadsheet-style grid (`enhanced-io-data-grid.tsx`). For VFD-heavy commissioning runs this is slow and error-prone — operators forget which devices they've finished, retest already-passed devices, and rely on memory to walk the floor.

The goal is a **guided, map-driven** mode that:
- presents devices as a visual factory layout (the SVG SCADA team already produces),
- recommends a next device,
- lets the operator skip and return,
- auto-passes IOs when the correct PLC tag triggers,
- detects swaps (wrong IO triggered) and offers a one-click "accept swap, fail both" with auto-generated comments.

The SCADA team already exports detailed-view SVGs (Inkscape) per MCM. The MCM09 export was used to validate the design.

There is unfinished WIP code from 2026-04-21 (~83 KB across `guided-mode-*` files + `app/api/guided/`) that built a tree-style topology view as a placeholder for the eventual SVG map. It was never committed and is fully orphaned (no entry point). This design treats the WIP UI as scrap; the back-end services (swap detection, device discovery SQL) are salvaged.

## 2. Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Approach | Fresh design, SVG-first | WIP UI was tree-shaped, not map-shaped; rebuilding around the map produces a cleaner mental model. |
| Flow | Guided "next" + skip-and-return + rich device color states | Real factory: VFDs sometimes can't be tested today (missing power, wiring rework). Strict sequence frustrates operators. |
| Coverage | VFDs only (whatever's in the SVG) | The MCM09 SVG only contains VFD blocks. Non-VFD IOs (TPE photoeyes, ENW encoders, pushbuttons, e-stops) stay in the existing manual grid for v1. Adding a "non-mapped IOs" rail (option B from brainstorming) is a small follow-up. |
| SVG storage (target) | Cloud-hosted, one SVG per **subsystem**, pulled with `/api/cloud/pull` | Project SVGs evolve over time; baking them into the field tool build is rigid. Per-subsystem (not per-MCM) so operators see one coherent map. |
| SVG storage (Phase 1) | File bundled at `frontend/public/maps/MCM09_Detailed_View.svg` | Lets us ship the visual prototype without touching the cloud repo. |

## 3. System architecture

Three tiers; in Phase 1 only the local tier changes.

```
┌─────────────────────┐    ┌─────────────────────┐    ┌──────────────────────┐
│ commissioning-cloud │    │     frontend/       │    │     React UI         │
│                     │    │   (local field      │    │  /commissioning/[id] │
│  SubsystemMaps      │◄──►│      tool)          │◄──►│        /guided       │
│  (Phase 2 only)     │    │  SubsystemMaps      │    │                      │
│                     │    │  (Phase 2 only)     │    │  GuidedTestingMap    │
│  POST  /admin/...   │    │                     │    │  DeviceTestPanel     │
│  GET   /sync/...    │    │  GET /api/maps/...  │    │  (drawer)            │
│                     │    │  GET /api/guided/   │    │                      │
│  Phase 2 only       │    │      devices        │    │                      │
└─────────────────────┘    └─────────────────────┘    └──────────────────────┘
```

**Cloud tier** — Phase 2 only. New `SubsystemMaps` table (Postgres), one upload endpoint (admin-only multipart), one fetch endpoint (API-key auth). Tiny upload card on the existing subsystem admin page.

**Local tier** — Phase 1 reads SVG from disk (`public/maps/`). Phase 2 caches in a local `SubsystemMaps` SQLite table populated by a new step in `/api/cloud/pull`. Local API serves the SVG to the React layer regardless of source.

**UI tier** — new route `/commissioning/[id]/guided`, separate from the manual grid. Operator opts in via a button on the existing commissioning page. Layout: thin header (back, progress, end-session), full-screen pan/zoom SVG, right-side drawer overlaying the map when a device is opened, floating "Next →" chip in the bottom-right.

## 4. UI design

### 4.1 Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ ← Back   Guided · Subsystem 16     [████░░] 12/47  ✓ ◑ ✗      ⋮    │
├──────────────────────────────────────────────────────────────────────┤
│                                                  ┌──────────────────┐│
│    ▢   ▢   ▢       ▢   ▢   ▢                    │ UL17_20_VFD      ││
│   UL  UL  UL      UL  UL  UL    ← SVG, pan/zoom │ 3 / 8 tested     ││
│                                                  │                  ││
│   ▢●▢   ← pulsing blue (current target)         │ ▶ RUN feedback   ││
│                                                  │   "Apply 24V"    ││
│   ▣ ▣ ✗   ← green / amber / red devices         │   ⏱ 24s          ││
│                                                  │                  ││
│                                                  │ ✓ Fault status   ││
│                                                  │ ✓ Speed FB       ││
│                                                  │ ✗ E-stop loop    ││
│                                                  │ … 4 more         ││
│                                                  │                  ││
│                                                  │ [Skip device]    ││
│                                                  └──────────────────┘│
│                                  ⊕ Recenter   Next: UL17_21_VFD →   │
└──────────────────────────────────────────────────────────────────────┘
```

### 4.2 Device color states

Each `<g id="…">` in the rendered SVG gets a `data-status` attribute set by React; CSS rules style fill and stroke. Bold, saturated colors for factory lighting.

| State | Fill | Stroke | When |
|---|---|---|---|
| Untested | white | gray | default |
| Current target | white | pulsing blue 3px | sequence's "next" device |
| In progress | amber | dark amber | some IOs tested, some not (paused/skipped mid-test) |
| Fully passed | green | dark green | every IO of this device passed |
| Has failures | red | dark red | all IOs tested, ≥1 failed |
| Skipped | striped gray | gray | session moved on without finishing |

### 4.3 Drawer (`DeviceTestPanel`)

- **Header:** device name, X to close, "Skip device" button.
- **Body:**
  - Current IO as a large card: expected action ("Trigger photoeye on UL17_20" / "Apply 24V to fault input") + 30 s countdown for DI auto-pass.
  - Other IOs in compact rows below: `✓` passed, `✗` failed, `●` pending.
  - For DOs: a "Fire output" button → writes to PLC → "Did it work?" with Pass/Fail buttons (Phase 2 wiring).
  - Swap detected: amber inline alert ("Detected wrong wiring: expected UL17_20.RUN, got UL17_21.RUN") with **Accept swap** / **Retry**.
- **Footer:** Done (enabled when all IOs tested or skipped); auto-closes when device is complete.

### 4.4 Recommended-next algorithm

SCADA-document order: parse `<g id>` elements in the order they appear in the SVG file. The SCADA team already laid out devices for floor-walk order, so we follow their work. Skip already-completed and currently-skipped devices. Failed devices are NOT auto-targeted but stay visible for manual retest.

### 4.5 Tablet readiness

44 px+ tap targets, no hover-required states, drawer min-width 360 px, high-contrast colors. Pan/zoom: pinch on touch, mouse-wheel + drag elsewhere.

## 5. Data model

### 5.1 Cloud-side (Phase 2)

```sql
CREATE TABLE "SubsystemMaps" (
  id           SERIAL PRIMARY KEY,
  subsystemId  INTEGER NOT NULL UNIQUE REFERENCES "Subsystems"(id) ON DELETE CASCADE,
  svgContent   TEXT NOT NULL,            -- raw <svg>...</svg>, ≤2 MB enforced server-side
  updatedAt    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updatedBy    VARCHAR(255)
);
```

### 5.2 Local-side (Phase 2)

```sql
CREATE TABLE IF NOT EXISTS SubsystemMaps (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  SubsystemId  INTEGER NOT NULL UNIQUE,
  SvgContent   TEXT NOT NULL,
  UpdatedAt    TEXT
);
```

### 5.3 WIP carryovers (kept as-is)

- `GuidedSessions` — already created by the existing `guided-sequence-service.ts` module. Add a `SkippedDevices` TEXT column (JSON array of device names skipped this session).
- `SwapDetections` — kept verbatim; populated by the existing swap algorithm.

### 5.4 Device-state derivation (no extra columns)

For each device, count its IOs grouped by `Result`:
- 0 untested AND 0 failed → **Passed**
- 0 untested AND ≥1 failed → **Failed**
- ≥1 untested:
  - device in current session's `SkippedDevices` JSON list → **Skipped**
  - else any IO tested → **In progress**
  - else → **Untested**

**Current target** = first device in SCADA-document order whose state is `Untested` or `In progress`.

## 6. APIs

### 6.1 Cloud (Phase 2)

- `POST /api/admin/subsystem-maps/:subsystemId` — admin-only, multipart upload, validates `<svg>` parses and ≤2 MB.
- `GET /api/sync/subsystem-map/:subsystemId` — API-key auth, returns `{ svgContent, updatedAt }` or 404.

### 6.2 Local

**Phase 1 (built now):**

- `GET /api/maps/subsystem/:id` — **NEW** — Phase 1 serves the bundled SVG from `frontend/public/maps/`. Phase 2 serves cached SVG from local DB.
- `GET /api/guided/devices?subsystemId=…` — **NEW** — read-only; returns devices in SCADA-document order joined to local IO data, each row stamped with computed state. Reads from existing `Ios` rows; no writes.

**Phase 2 (added later):**

- `POST /api/guided/session/start` — opens a guided session, returns `sessionId`.
- `POST /api/guided/session/:id/skip-device` — `{ deviceName }`, appends to `SkippedDevices`.
- `POST /api/guided/session/:id/end` — closes session.

Phase 1 keeps the skipped-device list in React state only — no `GuidedSessions` rows are written. This keeps Phase 1 free of any DB mutation, matching the "build the app, don't push tests" directive.

The existing routes under `app/api/guided/` (`sequence`, `session`, `swap`) from the WIP are deleted in the Phase 1 commit; they're replaced by the new shape over Phases 1 and 2.

`/api/cloud/pull` modification (Phase 2 only) — adds one new step alongside network/estop/L2 fetches: pull the subsystem map. Failure is non-blocking like the other steps.

## 7. State machine

Two-level, replacing the WIP's IO-level machine.

### Session level

```
idle → loading → in-progress → complete
                       ↓
                       └─→ stopped (manual)
```

State held in React (`useReducer`). Tracks `sessionId`, `subsystemId`, the device list with computed states, and the current target.

### Device level (only when drawer is open)

```
idle → expecting-di ─auto-pass→ next-io
              ↓ wrong-trigger
              swap-detected ─accept→ both-failed → next-io
                            └─retry→ expecting-di

idle → expecting-do ─fire+pass→ next-io
              ↓ fire+fail
              io-failed → next-io

(any state) → device-skipped (skip button) → drawer closes
when last io tested → device-complete → drawer closes
```

The session updates the affected device's state when the drawer closes and computes the next current-target.

## 8. Edge cases

- **No SVG uploaded for this subsystem** (Phase 2 case): guided page shows empty state ("No map uploaded yet for Subsystem N · contact admin") with a button to switch to the manual grid. No crash.
- **Device in SVG but no matching IOs in DB:** rendered as inert (gray, "no IOs configured" tooltip), excluded from sequence and progress count.
- **IO device in DB but not in SVG:** invisible in guided mode (per the v1 scope decision; addressed by the "non-mapped IOs rail" follow-up).
- **PLC disconnected mid-session:** auto-pass stops working; drawer still functions for manual pass/fail/skip; toast warns.
- **Operator closes the drawer mid-test:** device state becomes "in progress" (amber); session continues; drawer can be re-opened to resume.

## 9. Phasing

### Phase 1 — visual prototype (this build)

- Drop `MCM09_Detailed_View.svg` into `frontend/public/maps/`.
- Build all UI components and the new local API routes.
- Read-only against existing data: device state derives from current `Ios.Result` values, giving instant realism with whatever data is currently in local SQLite.
- **No DB writes, no PLC writes, no `/api/test` calls.** Pass/Fail/Skip clicks update React state and toast; nothing persists.
- Cloud repo: zero changes. No new tables, no upload endpoint, no admin UI, no `/api/cloud/pull` change.
- New route `/commissioning/[id]/guided`. Existing `/commissioning/[id]` (manual grid) untouched.

### Phase 2 — production wiring (deferred)

- Cloud-side: `SubsystemMaps` table, admin upload card, `GET /api/sync/subsystem-map/:id`.
- Local-side: `SubsystemMaps` table, new pull step, swap to DB-cached SVG (bundled file becomes a dev fallback).
- Wire `onPassIo` / `onFailIo` / `onFireOutput` to the existing test-recording APIs and PLC write helpers.
- Hook PLC tag-trigger WebSocket events to drive auto-pass + swap detection (the existing `__guidedModeIoTrigger` global pattern from the WIP code is reusable here).

## 10. WIP file fate

**Delete** in the Phase 1 commit (all currently untracked):

- `frontend/components/guided-testing-map.tsx`
- `frontend/components/guided-mode-controller.tsx`
- `frontend/components/guided-mode-panel.tsx`
- `frontend/lib/guided-mode-state.ts`
- `frontend/app/api/guided/sequence/`
- `frontend/app/api/guided/session/`
- `frontend/app/api/guided/swap/`

**Keep** (untouched in Phase 1, reused as-is by Phase 2 wiring):

- `frontend/lib/services/swap-detection-service.ts` — algorithm reused by Phase 2.
- `frontend/lib/services/guided-sequence-service.ts` — the device + IO SQL queries are reused. No rename — keeping the original name avoids unrelated churn.

## 11. Risk to active cloud users in Phase 1

**Zero.** All edits live in `frontend/`. The `commissioning-cloud` repo is not touched, no Postgres schema changes, no API contract changes. The active manual-mode commissioning page is also untouched — guided mode is opt-in via a separate route.

## 12. Acceptance criteria — Phase 1

- [ ] `/commissioning/[id]/guided` route exists and renders the SVG full-screen.
- [ ] Pan and zoom work on touch and mouse.
- [ ] Each VFD device on the SVG renders with the correct color state derived from current `Ios.Result` data.
- [ ] Tapping a device opens the drawer with that device's IOs listed.
- [ ] The current-target device pulses blue and is named in the floating "Next →" chip.
- [ ] Tapping "Next →" pans to and opens the current target.
- [ ] Pass / Fail / Skip clicks change the device's color state in the UI; no DB writes occur (verifiable via SQLite inspection: `Ios.Result` column unchanged).
- [ ] "Skip device" advances to the next-recommended device.
- [ ] Header progress bar updates as devices change state.
- [ ] No regressions in the existing `/commissioning/[id]` manual grid.
- [ ] No edits to `commissioning-cloud/`.

## 13. Non-goals (v1)

- Non-VFD IOs (photoeyes, encoders, e-stops, etc.).
- Multi-MCM map switcher (single subsystem-wide SVG).
- Real PLC integration (auto-pass on tag trigger, fire-output writes).
- Real DB writes (test results, history, swap detections).
- Cloud upload UI.
- Resume sessions across page reloads.
- Replay / review of past guided sessions.
