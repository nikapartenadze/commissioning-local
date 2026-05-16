# Roadmap-driven Guided Mode — Design

**Status:** approved (sections 1–7) on 2026-05-16, pending implementation
**Branches:** `feat/roadmap-guided-mode` on both `commissioning-cloud` and `commissioning-local/frontend`
**Scope:** demo branch only — not for merge to main, not for production deploy
**Predecessor docs:**
- `frontend/specs/2026-04-28-guided-mode-svg-design.md` — original Guided Mode design (SVG + flow modes)
- `frontend/specs/2026-05-15-guided-mode-status-and-phase2.md` — Phase 1 status and known gaps

## 1. Context & motivation

The Phase 1 prototype of Guided Mode (merged 2026-05-15) colors each device on an MCM SVG by its IO results and recommends a "next" device using **SCADA document order**. The operator still chooses which device to walk to and clicks Pass/Fail freely. That model leaves room for skipped tests, retests of already-passed devices, and floor-walk inefficiency.

The goal of this demo is a **fully scripted walkdown**: a supervisor authors a roadmap in the cloud — an ordered sequence of devices/IOs with per-step instruction text and an optional drawn walking path — and the field tool plays it back step-by-step. The electrician reads "Go to EPC1_2 and pull the cord," tests, then sees "Towards your left, go to EPC1_3 and pull the cord." No choice, no thinking, no skipping without an explicit override.

This slots into an extensibility point that's already in the codebase: the existing Guided Mode page's `FlowModeChip` lists "Custom route" as a placeholder future mode. This design fills that slot.

## 2. Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Authoring location | `commissioning-cloud` admin UI at `/admin/roadmaps` | Mirrors `/admin/diagrams`; admins already manage SCADA assets there |
| Sync model | Mirror the `McmDiagram` pattern: Postgres → cloud sync endpoint → local pull → SQLite cache | Offline-first; reuses the established pull plumbing |
| Step granularity | Mixed — a step is either a whole device or a specific IO | Author can pick granularity per step; "Pull the cord" maps to a single IO, full VFD test maps to a device |
| Authoring UX | Hybrid: click-on-SVG to add device-anchored steps **and** free-form path drawing for the walking path between steps | Matches the user's "free form path and predefined order" requirement |
| Local integration | Same `/commissioning/:id/guided` route, new `Roadmap` flow mode | Reuses every existing surface (map, drawer, sync); enables the long-promised "Custom route" menu item |
| Multiple roadmaps per MCM | Allowed | Different walkdowns (EPCs, VFDs, pre-energize checks) per diagram |
| Publish gate | `isPublished` boolean; only published roadmaps sync to field | Avoids in-progress edits leaking to the floor |
| Step completion | UI Pass/Fail click for the demo (same as Phase 1) | Real PLC auto-advance + DB persistence is Phase 2 work documented in the predecessor doc |

## 3. System architecture

Three new boxes — everything else is reused.

```
┌──────────────────────────────┐         ┌──────────────────────────────┐         ┌──────────────────────────────┐
│   commissioning-cloud        │         │  frontend/ (field laptop)    │         │   React UI                   │
│   Next.js 14 :3003           │  HTTPS  │  Express + Vite + SQLite     │   WS    │  /commissioning/:id/guided   │
│                              │ ◄─────► │                              │ ◄─────► │   FlowMode = "Roadmap"       │
│  Postgres:                   │         │  SQLite:                     │         │                              │
│    McmDiagram (exists)       │         │    McmDiagrams (exists)      │         │  RoadmapPlaybackBanner       │
│    Roadmap        (NEW)      │         │    Roadmaps      (NEW)       │         │  RoadmapPathOverlay          │
│                              │         │                              │         │  RoadmapPicker               │
│  /admin/diagrams  (exists)   │         │  /api/cloud/                 │         │  (existing map + drawer reused│
│  /admin/roadmaps     (NEW)   │         │      pull-roadmap   (NEW)    │         │                              │
│                              │         │  /api/roadmap/      (NEW)    │         │                              │
│  /api/admin/roadmaps (NEW)   │         │                              │         │                              │
│  /api/sync/roadmaps  (NEW)   │         │                              │         │                              │
└──────────────────────────────┘         └──────────────────────────────┘         └──────────────────────────────┘
```

## 4. Data model

### 4.1 Cloud — `Roadmap` (Prisma)

```prisma
// One authored walkdown route for a given MCM diagram. Multiple roadmaps per
// (project, mcm) allowed so supervisors can author different walks (EPCs only,
// VFDs only, pre-energize checks, etc.). Steps and path are stored as JSON
// for schema flexibility; both are validated by Zod on every write.
model Roadmap {
  id          Int      @id @default(autoincrement())
  projectId   Int      @map("project_id")
  mcm         String   @db.VarChar(64)        // matches McmDiagram.mcm
  name        String   @db.VarChar(120)
  description String?  @db.Text
  stepsJson   Json     @map("steps_json")
  pathJson    Json?    @map("path_json")
  isPublished Boolean  @default(false) @map("is_published")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  createdBy   String?  @map("created_by") @db.VarChar(255)
  project     Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@index([projectId, mcm])
  @@map("roadmaps")
}
```

### 4.2 Step and path shapes (TypeScript / Zod)

```ts
interface RoadmapStep {
  order: number                       // 1-indexed
  kind: 'device' | 'io'
  deviceName: string                  // matches the <g id> in the SVG
  ioName?: string                     // required only when kind === 'io'
  instructionText: string             // displayed in the playback banner
  transitText?: string                // optional movement cue: "towards your left"
}

interface RoadmapPath {
  segments: Array<{
    fromStep?: number                 // optional; auto-snapped from drawing
    toStep?: number                   // optional; auto-snapped from drawing
    points: Array<{ x: number; y: number }>   // SVG user-space coordinates
    style?: 'arrow' | 'dashed'
  }>
}
```

Both shapes are validated by a single Zod schema in `commissioning-cloud/lib/roadmap-schema.ts`; the local field tool imports the same shape into `frontend/lib/guided/roadmap-types.ts` (copy-paste; the projects do not share a package).

### 4.3 Local — `Roadmaps` (SQLite, mirror of cloud)

```sql
CREATE TABLE IF NOT EXISTS Roadmaps (
  Id           INTEGER PRIMARY KEY,           -- mirrors cloud id
  ProjectId    INTEGER NOT NULL,
  Mcm          TEXT NOT NULL,
  Name         TEXT NOT NULL,
  Description  TEXT,
  StepsJson    TEXT NOT NULL,
  PathJson     TEXT,
  IsPublished  INTEGER NOT NULL DEFAULT 0,
  UpdatedAt    TEXT
);
CREATE INDEX IF NOT EXISTS idx_roadmaps_mcm ON Roadmaps(Mcm);
```

Local rows are read-only — the source of truth is cloud. The local app never writes back to `Roadmaps` except through the pull route.

## 5. Cloud authoring UI

### 5.1 Routes

- `app/admin/roadmaps/page.tsx` — list page (table of roadmaps grouped by project/MCM).
- `app/admin/roadmaps/[id]/page.tsx` — editor for one roadmap.

Both gated by `isAdmin` from the existing NextAuth session (same as `/admin/diagrams`).

### 5.2 Editor layout

```
┌────────────────────────────────────────────────────────────────────────────┐
│  ← Back │ "EPC walkdown"  │ MCM: MCM09 │ [Save] [Publish ▼]  │ 5 steps / 2 paths │
├──────────────────────────────────────┬─────────────────────────────────────┤
│                                      │  STEPS                              │
│                                      │  ┌─────────────────────────────┐    │
│       SVG canvas (zoom/pan)          │  │ 1. EPC1_2 · pull cord       │    │
│                                      │  │    Text: "Go to EPC1_2 and  │    │
│   ● UL17_20  ● UL17_21               │  │    pull the cord"           │    │
│        1  ━━━━━▶  2                  │  │    IO: EPC1_2.CORD_PULL ▾   │    │
│                                      │  │    Transit: ""              │    │
│   ● EPC1_2 ━━▶ ● EPC1_3              │  ├─────────────────────────────┤    │
│        3            4                │  │ 2. EPC1_3 · pull cord       │    │
│                                      │  │    Text: "Now move left to  │    │
│                                      │  │    EPC1_3 and pull"         │    │
│  Mode: [● Add steps] [○ Draw path]   │  │    Transit: "left ~5m"      │    │
│  Tools: [↶ undo] [↷ redo] [⌫ clear]  │  └─────────────────────────────┘    │
│                                      │  + Add step from device click       │
└──────────────────────────────────────┴─────────────────────────────────────┘
```

### 5.3 Authoring modes (two on the canvas)

- **Add Steps mode** (default). Click a `<g id>` on the SVG → appends a step whose `deviceName` is that id and `kind: 'device'`. Device gets a numbered badge overlay. Clicking an existing badge selects its row in the right panel.
- **Draw Path mode.** Polyline tool — click-click-click to add waypoints; double-click or Esc ends a segment. Segments render as styled arrows. Starting/ending a segment on top of a device badge auto-snaps and sets `fromStep` / `toStep`.

### 5.4 Right-panel step row

Fields per step (top-to-bottom): drag handle / step number, device name (read-only), instruction text (required), optional IO dropdown (populated from `GET /api/admin/devices?projectId=...&mcm=...&device=...`), optional transit text, delete button. Selecting "any IO" in the IO dropdown sets `kind:'io'`; clearing it returns to `kind:'device'`.

### 5.5 Save / Publish

- **Save** persists `stepsJson` + `pathJson` + `name` + `description` as a draft (`isPublished` unchanged).
- **Publish** (button menu: Publish / Unpublish) flips `isPublished`. Only published roadmaps are returned by the cloud sync endpoint.
- **Conflict handling**: if `updatedAt` on the server has changed since the editor loaded, Save shows a "Roadmap was edited Xm ago by user@…—overwrite?" dialog.

### 5.6 Cloud APIs

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/admin/roadmaps?projectId=&mcm=` | `isAdmin` | list |
| `POST` | `/api/admin/roadmaps` | `isAdmin` | create empty (body: `{ projectId, mcm, name }`) |
| `GET` | `/api/admin/roadmaps/[id]` | `isAdmin` | fetch for editor |
| `PUT` | `/api/admin/roadmaps/[id]` | `isAdmin` | save whole `{ name, description, stepsJson, pathJson }` |
| `PATCH` | `/api/admin/roadmaps/[id]/publish` | `isAdmin` | flip `isPublished` |
| `DELETE` | `/api/admin/roadmaps/[id]` | `isAdmin` | delete |
| `GET` | `/api/admin/diagrams/by-mcm?projectId=&mcm=` | `isAdmin` | helper — returns SVG content for the editor canvas |
| `GET` | `/api/admin/devices?projectId=&mcm=&device=` | `isAdmin` | helper — returns device list (or one device's IOs) for the IO dropdown |
| `GET` | `/api/sync/roadmaps?subsystemId=N` | `X-API-Key`, rate-limited | field-tool-facing — returns all published roadmaps for the subsystem's MCM |

All admin routes use Zod for body validation. The sync route returns 404 if no published roadmaps exist; the field tool treats this as "no roadmaps available" (FlowModeChip item stays disabled).

## 6. Local playback UI

### 6.1 Entry

Same `/commissioning/:id/guided` route. The existing `FlowModeChip` already exposes "Custom route" as a disabled future option — this design enables it and renames it "Roadmap" (the chip label becomes "Flow: Roadmap" once selected). Selecting it reveals a `RoadmapPicker` `<select>` listing all locally-cached published roadmaps for this MCM. Choosing one starts playback at step 1.

### 6.2 Playback layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ← Back  │  Roadmap: EPC walkdown  │  ████░░░ 3/8  │  [End roadmap]    │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│                       SVG canvas (current device pulsing)                │
│                                                                          │
│   non-target devices: dimmed, click-disabled                             │
│   path arrows from previous step → current step                          │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│  STEP 3 OF 8                                                             │
│  ► Go to EPC1_2 and pull the cord                                        │
│    Targeting IO: EPC1_2.CORD_PULL                                        │
│                                                  [Pass] [Fail] [Skip]    │
└──────────────────────────────────────────────────────────────────────────┘
```

### 6.3 Behaviors

- Map auto-centers/zooms to the step's `deviceName` on each advance (reuses `mapRef.current.centerOnDevice`).
- `RoadmapPathOverlay` draws `pathJson.segments`: the segment whose `toStep === currentStep` renders as an animated dashed arrow; completed legs are faint.
- **Lock mode**: every `<g id>` other than the current target gets `data-roadmap-locked="true"` → CSS sets `pointer-events: none; opacity: 0.4`. The operator literally cannot click the wrong device.
- `RoadmapPlaybackBanner` replaces the floating "Next" chip in the bottom 96 px of the viewport. Shows `instructionText` (large), step number / total, optional `transitText` as subtitle, and Pass/Fail/Skip buttons.
- **Advance condition** (computed via `lib/guided/roadmap-advance.ts`):
  - `kind: 'device'` — advance when the device's computed state becomes `passed` or `failed`.
  - `kind: 'io'` — advance when the specific IO's effective result becomes non-null.
- On advance: 200 ms fade swap of banner content, map pans, drawer re-opens for the new target.
- "Skip" records `step.result = 'skipped'` in the session state but does not change DB; this is the only choice the operator gets.
- "End roadmap" cancels playback and returns to free Guided Mode (SCADA-order flow).
- At step N: banner becomes "Roadmap complete · X passed · Y failed · Z skipped"; the map shows the full path traced.

### 6.4 State

```ts
interface RoadmapSession {
  status: 'idle' | 'playing' | 'complete' | 'cancelled'
  roadmapId: number | null
  steps: RoadmapStep[]
  path: RoadmapPath | null
  currentStepIndex: number   // 0-based; === steps.length when complete
  stepResults: Array<{ result: 'passed' | 'failed' | 'skipped' | null }>
}
```

Lives in a new `use-roadmap-session.ts` `useReducer` hook, sibling to the existing `use-guided-session.ts`. The page composes both: `useGuidedSession` continues to own device data and drawer state; `useRoadmapSession` is layered on top and drives the active target when roadmap mode is on.

### 6.5 Local APIs

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/cloud/pull-roadmap` | mirrors `/api/cloud/pull-mcm-diagram` — calls cloud `/api/sync/roadmaps` for the configured subsystem and upserts into local `Roadmaps` |
| `GET` | `/api/roadmap?subsystemId=N` | returns the cached published roadmaps for that subsystem's MCM |

### 6.6 Files added / modified

**New (local field tool):**
- `lib/guided/roadmap-types.ts`
- `lib/guided/roadmap-advance.ts` (pure, TDD)
- `lib/guided/use-roadmap-session.ts`
- `components/guided/roadmap-playback-banner.tsx`
- `components/guided/roadmap-path-overlay.tsx`
- `components/guided/roadmap-picker.tsx`
- `app/api/cloud/pull-roadmap/route.ts`
- `app/api/roadmap/route.ts`
- `__tests__/roadmap-advance.test.ts`
- `__tests__/roadmap-session-reducer.test.ts`
- `__tests__/roadmap-types-validation.test.ts`

**Modified (local field tool):**
- `components/guided/guided-mode-page.tsx` — compose roadmap state; render banner + overlay when active.
- `components/guided/guided-testing-map.tsx` — accept `lockedDevices: Set<string>` and stamp `data-roadmap-locked`.
- `components/guided/guided-mode.css` — three new rules (`data-roadmap-locked`, `data-roadmap-current`, banner styles).
- `lib/db-sqlite.ts` — add `Roadmaps` table bootstrap.
- `routes/index.ts` — mount the two new local API routes.

**New (cloud):**
- `prisma/schema.prisma` — `Roadmap` model.
- `lib/roadmap-schema.ts` — Zod schema for steps + path.
- `app/admin/roadmaps/page.tsx` + `[id]/page.tsx`.
- `components/roadmap-editor.tsx` (main canvas + step list composition).
- `components/roadmap-svg-canvas.tsx` (SVG with click/draw handlers).
- `components/roadmap-step-list.tsx`.
- `components/roadmap-mode-toolbar.tsx`.
- `app/api/admin/roadmaps/route.ts` + `[id]/route.ts` + `[id]/publish/route.ts`.
- `app/api/admin/diagrams/by-mcm/route.ts` (helper).
- `app/api/admin/devices/route.ts` (helper — confirmed not present today; new). Resolves devices for the IO dropdown by querying `Io` rows where the subsystem's `name` matches `mcm`, grouped by the IO's network-device field.
- `app/api/sync/roadmaps/route.ts`.

## 7. Edge cases

| Case | Behavior |
|---|---|
| No roadmap exists for this MCM | FlowModeChip's "Roadmap" item is disabled with tooltip "No roadmaps published for {MCM}" |
| Roadmap references a `deviceName` not in the current SVG | Banner shows instruction text + `⚠ Device not on map`; no target highlight; Pass/Fail/Skip still work |
| Roadmap references an `ioName` not in DB | Step renders with red border on the IO chip; Skip is the only working action; logged via `console.error` |
| Operator changes subsystem mid-roadmap | Roadmap session cancels; toast "Roadmap ended — subsystem changed" |
| SVG fails to load while roadmap is playing | Falls back to text-only banner (still shows instruction); Pass/Fail/Skip from the banner |
| `/api/cloud/pull-roadmap` fails | Returns existing cached rows; UI shows "Last synced: Xm ago". Non-blocking like other sync steps. |
| Invalid `stepsJson` on save (cloud) | Zod 400 with field path; editor surfaces the error inline on the offending step |
| Editor opened for a deleted roadmap | 404 → redirect to `/admin/roadmaps` with toast |
| Concurrent edits in cloud (two admins) | Last-write-wins; warning dialog on save when `updatedAt` shifted since load |
| Network drops mid-playback | Playback continues uninterrupted; results queue via existing sync queue |

## 8. Testing

### 8.1 Local field tool (Vitest, existing)

- `__tests__/roadmap-advance.test.ts` — pure `shouldAdvanceStep(step, deviceState, ioResult)` covering both `kind: 'device'` and `kind: 'io'` and the boundary cases (no IOs, mid-test, after pass, after fail).
- `__tests__/roadmap-session-reducer.test.ts` — reducer transitions: `START`, `ADVANCE`, `SKIP_CURRENT`, `END`, `COMPLETE`.
- `__tests__/roadmap-types-validation.test.ts` — Zod validates incoming roadmap JSON from `/api/roadmap` (defends against malformed cache rows).
- Manual: pull a roadmap → select in FlowMode → play through with Pass clicks → verify auto-advance, map pans, banner updates, locked non-targets.

### 8.2 Cloud

`commissioning-cloud` has no test framework configured. We will not introduce one for this demo. Validation comes from:
- TypeScript + Zod on every request body.
- Manual round-trip: create → save → publish → unpublish → delete.
- Manual editor flow: 5 steps, 2 path segments, IO dropdown, drag-reorder, conflict dialog.

### 8.3 End-to-end demo script (lives in `frontend/docs/demo-roadmap-playthrough.md` as part of implementation)

1. Cloud admin creates a roadmap on an MCM with an existing diagram, adds ≥3 steps mixing `kind:device` and `kind:io`, draws ≥2 path segments, publishes.
2. Local field tool: configure that MCM as the active subsystem; click "Pull roadmap"; FlowModeChip → Roadmap → pick that roadmap.
3. Play through: each step pans the map to the target, banner shows instruction text, non-targets are locked, Pass click auto-advances. After the last step, completion banner renders.

## 9. Branching, phasing, demo plan

### 9.1 Branches

- `commissioning-cloud`: `feat/roadmap-guided-mode` off `main`.
- `commissioning-local/frontend`: `feat/roadmap-guided-mode` off `main`.
Same branch name in both for symmetry. Neither is intended for merge during this demo cycle.

### 9.2 Single-phase implementation for the demo

Ship the full vertical slice on the demo branches: cloud authoring + sync endpoint + local pull + local playback. Do not merge to main. Do not deploy cloud to production. Cloud changes can be exercised against `npm run dev` on port 3003 with a local Postgres (or a temporary feature schema on the existing dev DB). The local field tool can be pointed at it via `config.json` (`cloudUrl: http://localhost:3003`).

### 9.3 Out of scope for the demo

- Real PLC tag-trigger auto-advance — playback advances on UI Pass/Fail clicks (same gap as today's Phase 1).
- Persisting Pass/Fail to the DB through `/api/test` — Phase 2 work in the predecessor doc.
- Multi-MCM roadmaps (cross-diagram transitions).
- Roadmap version history / draft snapshots.
- Production migration via `prisma migrate deploy`.

### 9.4 Acceptance criteria

- Cloud admin can create a roadmap on any MCM with a diagram, add ≥3 steps mixing `kind:device` and `kind:io`, draw a path with ≥2 segments, publish.
- Local field tool with that MCM configured can pull and play the roadmap end-to-end: banner shows correct text, map pans, non-targets locked, Pass click auto-advances, completion screen renders.
- Existing Guided Mode (SCADA-order flow) and the manual IO grid are unchanged. Zero regressions.
- Both repos build and run dev servers without errors (`npm run dev` in `commissioning-cloud` on :3003; `npm run dev` in `frontend/` on :3010).

## 10. Risk to active users

**Zero — demo only.** All work lives on `feat/roadmap-guided-mode` branches; no merge, no deploy. The cloud Postgres schema does receive a new `roadmaps` table when running `prisma db push` against a dev DB, but production Postgres is untouched (deploy is manual and explicit; see `commissioning-cloud/CLAUDE.md` §Deployment).
