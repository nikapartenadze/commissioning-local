# Guided Mode — Status & Phase 2 Handoff

**Date:** 2026-05-15
**Status:** Phase 1 visual prototype merged into `main` (commit `ea0c15d`, merging `merge-guided`). Toolbar entry shipped behind a BETA badge.
**Related docs:**
- `specs/2026-04-28-guided-mode-svg-design.md` — original design (still authoritative for architecture decisions)
- `specs/2026-04-28-guided-mode-svg-plan.md` — Phase 1 task plan (executed)

This document records *what got built*, *what was deliberately faked*, and *what Phase 2 has to do to make it real*. It exists so the next person picking this up doesn't have to reverse-engineer the state from git logs and inline comments.

---

## 1. What "production-ready" means here and where we are

Guided Mode is NOT production-ready. It is a visual prototype, by design — see `specs/2026-04-28-guided-mode-svg-design.md` §2 ("Phase 1") and the in-code `PHASE 1 ONLY` comment in `components/guided/device-test-panel.tsx`.

What works today:
- `/commissioning/:id/guided` route renders.
- A bundled MCM09 floor-plan SVG with pan/zoom on tablets.
- Devices on the map are color-coded by current `Ios.Result` aggregates (read-only).
- Recommended-next-device computation, "Next →" pans/zooms to the target.
- Device drawer with IO list, current-IO hero card, keyboard shortcuts (P/F/S/N).
- Auto-advance device → device when all IOs on the current device are marked.
- Mocked swap-detection dialog (triggered via "Simulate swap" button).
- 21 unit tests across `__tests__/guided-*` files, all green.

What does **not** work — the four reasons this is a prototype, not a tool:

| # | Gap | Where it's faked | Real source |
|---|---|---|---|
| 1 | Pass/Fail does not persist | `device-test-panel.tsx` `markResult()` mutates `localResults` React state only | Should call `POST /api/ios/:id/test` (the same endpoint the IO grid uses) |
| 2 | PLC signal watcher is mocked | `device-test-panel.tsx` Phase 1 comment | Should subscribe via `usePlcWebSocket().onIOUpdate` and key off real `UpdateState` messages |
| 3 | SVG is hardcoded MCM09 | `app/api/maps/subsystem/[id]/route.ts` serves the bundled file regardless of `:id` | Should query local `McmDiagrams` table (already pulled from cloud by `/api/cloud/pull-mcm-diagram`) |
| 4 | Swap detection is a button | "Simulate swap" in the device panel | Should fire automatically when WS reports a state change on an `Ios.id` ≠ expected, AND the offending id is also on the active subsystem |

---

## 2. File map (Phase 1 deliverables)

All paths relative to `frontend/`.

**SVG asset (bundled, dev-only fallback)**
- `public/maps/MCM09_Detailed_View.svg` — single file, ~127 KB

**Route**
- `src/router.tsx` — `/commissioning/:id/guided` → lazy import
- `app/commissioning/[id]/guided/page.tsx` — 5-line shell that renders `<GuidedModePage>`

**Server (Express handlers)**
- `app/api/maps/subsystem/[id]/route.ts` — `GET`, serves the bundled SVG. **Hardcoded to MCM09 in Phase 1.**
- `app/api/guided/devices/route.ts` — `GET` ordered devices for a subsystem with IO counts
- `app/api/guided/devices/[name]/route.ts` — `GET` IO list for one device

**Library code**
- `lib/guided/types.ts` — `Device`, `DeviceState`, `IoSummary`
- `lib/guided/svg-parser.ts` — extracts `<g id="…">` device ids in document order
- `lib/guided/device-state.ts` — derives device state from IO counts + skipped set; `findCurrentTarget`
- `lib/guided/use-guided-session.ts` — `useReducer` hook for drawer + skipped + selected state

**UI components**
- `components/guided/guided-mode-page.tsx` — page composition (header, map, drawer, chip)
- `components/guided/guided-testing-map.tsx` — inlines the SVG, injects `data-status`, click + pan/zoom (`react-zoom-pan-pinch`)
- `components/guided/device-test-panel.tsx` — right pane: empty state, current-IO card, IO list, mocked watcher, swap banner
- `components/guided/guided-mode.css` — colors keyed by `data-status` on `<g>` elements
- `components/plc-toolbar.tsx` — BETA entry (lines around 407–425) `<Link to={\`/commissioning/${subsystemId}/guided\`}>`

**Tests (Vitest)**
- `__tests__/guided-svg-parser.test.ts`
- `__tests__/guided-device-state.test.ts`
- `__tests__/guided-session-reducer.test.ts`

**Dev ports (changed by the merge)** — `package.json` `dev` script uses `cross-env PORT=3010 PLC_WS_PORT=3012 WS_BROADCAST_URL=http://localhost:3112/broadcast`. UI on Vite (5173 or auto-bumped).

---

## 3. How it actually behaves today (so you can demo / verify)

1. Run `npm run dev` from `frontend/`.
2. Open the running Vite URL (e.g. `http://localhost:5174`) and pick or accept a subsystem (`SUB 71` in current config).
3. Click the small **Guided Mode BETA** chip in the toolbar (between START/STOP and the right-side stats cluster).
4. You land at `/commissioning/71/guided`. The MCM09 SVG renders even though MCM09 isn't your project — see gap #3.
5. Devices on the SVG colored green/red/grey from `Ios.Result` aggregates already in the local DB. Device state derivation is in `lib/guided/device-state.ts`.
6. Click any device, or click "Begin →" chip to open the recommended-next.
7. In the drawer: click Pass/Fail on the current-IO card OR press `P`/`F` keys. *Nothing is saved.* Refresh the page — your marks vanish.
8. "Simulate swap" opens the swap dialog with a fake actual-IO. The accept-swap path is wired through the UI but, again, doesn't persist.

---

## 4. Cloud-side groundwork already in place

When the original design wrote "Phase 2 will add cloud SVG storage", we already built most of that — it's just not yet wired to guided mode.

In `commissioning-cloud/`:
- `prisma/schema.prisma` — `McmDiagram` model keyed `(projectId, mcm)`, `svgContent: Text`, `uploadedBy`, `uploadedAt`. Already migrated to prod.
- `app/admin/diagrams/page.tsx` — admin page at `/admin/diagrams` with project picker, SVG upload, list, preview, delete.
- `components/mcm-diagrams-manager.tsx` — uploader UI; auto-detects `MCM##` from filename; 5 MB cap; validates `<?xml`/`<svg` prefix.
- `app/api/admin/mcm-diagrams/route.ts` — `GET` (list) and `POST` (upsert).
- `app/api/admin/mcm-diagrams/[id]/route.ts` — `GET` (fetch full SVG) and `DELETE`.
- `app/api/sync/mcm-diagram/route.ts` — `GET ?subsystemId=N` with `X-API-Key` auth, rate-limited. Looks up `Subsystem.name` → MCM → returns SVG + metadata.

**Uncommitted on `commissioning-cloud` (worth committing — does not block Phase 2 but supports it):**
- `lib/mcm-diagram-coverage.ts` — `extractSvgIds()` + `computeCoverage({projectId, mcm, svgContent})` returning `{expected, missing, presentCount, expectedCount, missingCount}`. Source of truth = `Subsystem(name=mcm) → Io.deviceId → Device.name`. Case-insensitive match.
- `app/api/admin/mcm-diagrams/route.ts` and `[id]/route.ts` — extended to include the coverage report on upload and detail fetch.
- `components/mcm-diagrams-manager.tsx` — extended with `<CoverageBadge>` ("Missing N / M" amber, "M / M ✓" green, "No IO devices" muted) and `<MissingDevicesPanel>` listing missing device names below the SVG preview.

In `commissioning-local/frontend/`:
- `app/api/cloud/pull-mcm-diagram/route.ts` — POST that pulls from the cloud sync endpoint for the configured subsystem and upserts into local `McmDiagrams` SQLite table.
- `app/api/mcm-diagram/[mcm]/route.ts` — GET local cached SVG.
- `components/mcm-diagram-view.tsx` — read-only viewer, `DOMPurify`-sanitized, supports `highlightTag` prop (matches an SVG element `id`).
- `app/diagram/page.tsx` + router entry — standalone viewer at `/diagram?tag=…`.

So the data path **admin uploads → cloud stores → local pulls → local caches** is complete and shippable. Guided Mode's Phase 2 just needs to *use* it.

---

## 5. Pre-existing untracked services (`lib/services/`)

The `merge-guided` plan explicitly preserved two files that pre-dated the SVG redesign:
- `lib/services/guided-sequence-service.ts` — IO walking-order computation (Ring → Node → Port → Sub-port → IO with DI → DO → AI → AO sort), `GuidedSessions` + `SwapDetections` SQLite table bootstrap, `startSession/endSession/recordSwap/acceptSwap` helpers.
- `lib/services/swap-detection-service.ts` — `analyzeSwap` and `inferFailureMode`. Diagnoses (`swap` / `miswire` / `crosstalk`) and suggests `failureMode + comment + trade` for the `/api/ios/:id/test` body.

These are still untracked on `main` — kept on disk as Phase 2 building blocks, per the original plan ("WIP files to keep untouched (Phase 2 will reuse)"). The reducer in `lib/guided/use-guided-session.ts` is **device-centric** (devices on a map); these services are **IO-centric** (walking order through individual IOs). For Phase 2 swap detection, the swap analyzer in `swap-detection-service.ts` is the right thing to import directly. The session/swap-recording tables it creates can either be reused or dropped — Phase 1's reducer is in-memory only.

**Action:** commit them as part of Phase 2 when they get wired up, or delete them if Phase 2 chooses a different design. Don't leave them dangling forever — they're stale-looking right now.

---

## 6. Phase 2 work — concrete plan

Order matters: each step compounds the next. Roughly half a sprint of work.

### Step 1 — Persist Pass/Fail (1–2 days)

**Why first:** without this nothing else matters. The whole point of the tool is recording test results.

- In `components/guided/device-test-panel.tsx`, replace `markResult()` with a real call:
  ```ts
  await authFetch(`/api/ios/${io.id}/test`, {
    method: 'POST',
    body: JSON.stringify({ result, comments, currentUser, failureMode }),
  })
  ```
  Use `authFetch` from `@/lib/api-config` (NOT raw fetch). Pull `currentUser` from `useUser()` in `@/lib/user-context`.
- Drop `localResults` state — read result from the server response and refresh the device's IO list, or subscribe to WS `UpdateIO` so other tabs propagate too.
- Add fail-comment dialog (the existing `<FailCommentDialog>` is generic now — `bf865d2 refactor(fail-dialog): generic io prop so EPC view can reuse the dialog`).
- Keep the keyboard shortcuts; they're great for desktop dev.

**Acceptance:** Pass an IO in guided mode → switch to the I/O tab → it shows Passed with timestamp + user. Refresh → state persists. Cloud sync queue picks it up within seconds.

### Step 2 — Wire real PLC streaming (1 day)

- In `device-test-panel.tsx` (or pull up into `guided-mode-page.tsx`), call `usePlcWebSocket()` once and register `onIOUpdate`.
- Each update gives `{Id, State: 'TRUE'|'FALSE'|'NOT_SET', Result, Timestamp, Comments}`. Drive the live-state badge on the current-IO card from this.
- Drop the mocked watcher block.

**Acceptance:** Open guided mode against a connected PLC → live TRUE/FALSE updates on the current IO without any user action.

### Step 3 — Map by subsystem (1 day)

- Change `app/api/maps/subsystem/[id]/route.ts` to:
  1. Resolve the subsystem's MCM name from local DB (`SELECT Name FROM Subsystems WHERE id = ?` — see `lib/db-sqlite.ts` table layout).
  2. Look up `SELECT SvgContent FROM McmDiagrams WHERE McmName = ?`.
  3. If hit → serve as `image/svg+xml`.
  4. If miss → fall back to the bundled MCM09 only if `subsystemId` is one tied to MCM09; otherwise 404 with a helpful "Pull diagram from cloud first" message.
- Add a "Pull diagram" button on the guided page header that calls the existing `/api/cloud/pull-mcm-diagram` and re-renders.
- Optional: surface the coverage report ("3 of 47 devices missing from diagram") that the cloud-side already computes — round-trip it via the sync endpoint or refetch the admin endpoint.

**Acceptance:** Switch the runtime subsystem → guided map updates to the correct MCM. Admin uploads a new diagram on the cloud → field hits Pull → new diagram renders.

### Step 4 — Real swap detection (2–3 days)

- In `guided-mode-page.tsx`, register a second `onIOUpdate` callback that:
  1. Resolves "expected IO" = the current-IO card's `Ios.id` in the active drawer.
  2. If `update.Id !== expected.id`, `update.State === 'TRUE'`, AND `update.Id` is in the subsystem's IO list (i.e. it's a known IO that fired by mistake) → suspect swap.
  3. Dedup via a small ring buffer keyed on `(expectedId, triggeredId)` and 5s window.
  4. Look up both IOs' devices via `lib/guided/device-state.ts` + the per-device fetch.
  5. Call `analyzeSwap` from `lib/services/swap-detection-service.ts` (the pre-existing service) → get a `SwapDetectionResult`.
  6. Open the existing swap dialog UI (`device-test-panel.tsx` has the styled banner already; pull it up if needed).
  7. Accept-swap → call `POST /api/ios/:expectedId/test` with `result='Fail', failureMode='Wrong wiring', comments=analysis.suggestedComment`. Then advance.
- Drop the "Simulate swap" button (or keep it under a dev flag).
- Decide whether to persist swap detections (`SwapDetections` table from `guided-sequence-service.ts`) for an audit trail. Probably yes — useful for the cloud-side punchlist analytics.

**Acceptance:** With a real PLC, expected IO X but tech activates IO Y → swap dialog opens unprompted within ~1s, accept → IO X is failed with auto-comment, sequence advances to next.

### Step 5 — Polish + remove BETA

- Remove the BETA badge in `components/plc-toolbar.tsx`.
- Add a one-shot guided tour (the `GuidedTour` Joyride component) covering the SVG, drawer, keyboard shortcuts.
- Field-test on hardware (tablet + PLC + real tech). The plan's risk note about pan/zoom UX is still open.
- Decide on the pre-existing `lib/services/*` files: commit if wired, delete if superseded.

---

## 7. Things easy to forget

- **Dev port changed.** Express now on **3010**, broadcast on **3112**, PLC WS on **3012**, UI on Vite (5173/5174). Old muscle memory says 3000 — that's wrong on this branch.
- **`Ios.deviceId` may be null.** The cloud-side `Device` linkage isn't 100% populated — coverage check is silent on those. Local `NetworkPorts.DeviceName` is sometimes a better source.
- **`McmDiagram` is project + MCM scoped, not subsystem scoped.** Multiple subsystems can share an MCM name. The lookup is `Subsystem.name` (the MCM identifier) — keep that consistent.
- **SVG is admin-uploaded user content.** The field tool already runs it through `DOMPurify` (see `components/mcm-diagram-view.tsx`). The guided `guided-testing-map.tsx` injects via `innerHTML` — verify it sanitizes the same way before Phase 2 ships, or wrap it.
- **The merge brought a port change and new deps.** A fresh checkout needs `npm install` before `npm run dev` (`react-zoom-pan-pinch` is new).
- **Cloud SVG coverage work is uncommitted** (still on the working tree of `commissioning-cloud`). Commit it before Phase 2, or it'll silently disappear on a `git checkout`.

---

## 8. Definition of "done" for Phase 2

- Pass/Fail in guided mode hits the DB and syncs to cloud, identical to the I/O grid.
- Live PLC state shows on the current-IO card.
- Map resolves per-subsystem from `McmDiagrams`, not from the bundled file.
- Swap detection fires automatically on a real wrong-IO trigger.
- BETA badge removed.
- A field tech has run a real commissioning session in guided mode and signed off on it.
- Pre-existing `lib/services/guided-sequence-service.ts` + `swap-detection-service.ts` are either committed (wired) or deleted (superseded).
