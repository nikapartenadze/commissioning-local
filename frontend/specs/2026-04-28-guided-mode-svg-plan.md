# Guided Mode (SVG-driven) — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a visual prototype of guided IO checkout mode driven by a SCADA SVG map. Operator opens `/commissioning/:id/guided`, sees the MCM09 factory layout with each VFD color-coded by its current test state, can click any device to open a side drawer and walk through its IOs, can skip devices and follow the recommended-next sequence. **No DB writes, no PLC writes, no real test recording** — pure visual prototype reading state from existing local data.

**Architecture:** New React route `/commissioning/:id/guided` separate from the existing manual grid. SVG bundled as static asset at `frontend/public/maps/MCM09_Detailed_View.svg`. Two new local API endpoints: one serves the SVG, one returns devices in SVG document order with computed states (passed/failed counts derived read-only from `Ios.Result`). Drawer state lives in a `useReducer` hook; skipped-device list is in-memory only this round.

**Tech Stack:** React 18 + React Router (existing), Express 5 + TypeScript handlers (existing), better-sqlite3 (existing), Vitest (existing), `react-zoom-pan-pinch` (NEW — for SVG pan/zoom on tablets), shadcn/ui (existing).

**Spec:** `frontend/specs/2026-04-28-guided-mode-svg-design.md`

---

## File Structure

**Bundle:**
- `frontend/public/maps/MCM09_Detailed_View.svg` — the SVG file copied from the user's Downloads.

**New library code:**
- `frontend/lib/guided/types.ts` — `Device`, `DeviceState`, `IoSummary` types.
- `frontend/lib/guided/svg-parser.ts` — `parseDeviceIdsFromSvg(svg)` returns ordered array of `<g id>`s.
- `frontend/lib/guided/device-state.ts` — `computeDeviceState(counts, isSkipped)` and `findCurrentTarget(devices)`.
- `frontend/lib/guided/use-guided-session.ts` — React hook with reducer for drawer + skipped + selected state.

**New API routes (Express handlers):**
- `frontend/app/api/maps/subsystem/[id]/route.ts` — `GET` returns the bundled SVG file as `image/svg+xml`.
- `frontend/app/api/guided/devices/route.ts` — `GET` returns ordered devices joined to live IO counts.

**New components:**
- `frontend/components/guided/guided-mode-page.tsx` — page wrapper composing header + map + drawer + chip.
- `frontend/components/guided/guided-testing-map.tsx` — fetches SVG, injects `data-status`, click handlers, pan/zoom.
- `frontend/components/guided/device-test-panel.tsx` — drawer with IO list, current IO card, skip + done buttons.
- `frontend/components/guided/guided-mode.css` — color rules keyed by `data-status` on `<g>` elements.
- `frontend/app/commissioning/[id]/guided/page.tsx` — thin route page that renders `<GuidedModePage />`.

**Routing modifications:**
- `frontend/src/router.tsx` — add `/commissioning/:id/guided` route.
- `frontend/routes/index.ts` — mount the two new API routes.

**Entry point modification:**
- `frontend/components/plc-toolbar.tsx` (or wherever the current page has a relevant header) — add a small "Guided Mode" button. **Final exact location decided in Task 11 after looking at the live UI.**

**Tests (Vitest, located in `frontend/__tests__/`):**
- `frontend/__tests__/guided-svg-parser.test.ts`
- `frontend/__tests__/guided-device-state.test.ts`
- `frontend/__tests__/guided-session-reducer.test.ts`

**WIP files to delete (currently untracked):**
- `frontend/components/guided-mode-controller.tsx`
- `frontend/components/guided-mode-panel.tsx`
- `frontend/components/guided-testing-map.tsx`
- `frontend/lib/guided-mode-state.ts`
- `frontend/app/api/guided/sequence/`
- `frontend/app/api/guided/session/`
- `frontend/app/api/guided/swap/`

**WIP files to keep untouched** (Phase 2 will reuse): `lib/services/swap-detection-service.ts`, `lib/services/guided-sequence-service.ts`.

---

## Task 1: Bundle SVG, install dependency, delete WIP UI

**Files:**
- Create: `frontend/public/maps/MCM09_Detailed_View.svg` (copied from Downloads)
- Modify: `frontend/package.json` (add `react-zoom-pan-pinch`)
- Delete: WIP UI files listed above

- [ ] **Step 1: Copy the SVG into the bundled assets folder**

```bash
mkdir -p frontend/public/maps
cp "/c/Users/nika.fartenadze.LCIBATUMI/Downloads/MCM09_Detailed_View.svg" frontend/public/maps/MCM09_Detailed_View.svg
```

Expected: file exists at `frontend/public/maps/MCM09_Detailed_View.svg`, ~127 KB.

- [ ] **Step 2: Install pan/zoom dependency**

Run from `frontend/`:
```bash
npm install react-zoom-pan-pinch@3
```

Expected: `package.json` gets `"react-zoom-pan-pinch": "^3.x.x"` under dependencies.

- [ ] **Step 3: Delete WIP UI files**

```bash
rm frontend/components/guided-mode-controller.tsx
rm frontend/components/guided-mode-panel.tsx
rm frontend/components/guided-testing-map.tsx
rm frontend/lib/guided-mode-state.ts
rm -rf frontend/app/api/guided/sequence
rm -rf frontend/app/api/guided/session
rm -rf frontend/app/api/guided/swap
```

Verify the kept services are still present:
```bash
ls frontend/lib/services/swap-detection-service.ts frontend/lib/services/guided-sequence-service.ts
```

Both must still exist.

- [ ] **Step 4: Commit**

```bash
git add frontend/public/maps/MCM09_Detailed_View.svg frontend/package.json frontend/package-lock.json
git commit -m "chore(guided): bundle MCM09 SVG, add react-zoom-pan-pinch, drop WIP guided UI

Phase 1 prep for the SVG-driven guided mode. SVG bundled as static asset
(replaced by cloud pull in Phase 2). WIP UI files were untracked, never
shipped, and are being replaced by a fresh map-first implementation. Kept
swap-detection-service.ts and guided-sequence-service.ts for Phase 2 reuse.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Define guided-mode types

**Files:**
- Create: `frontend/lib/guided/types.ts`

- [ ] **Step 1: Write the types module**

Create `frontend/lib/guided/types.ts`:

```typescript
/**
 * Computed visual state for a device on the guided map.
 * Derived from per-IO test results plus the session's skipped list.
 */
export type DeviceState =
  | 'untested'      // no IOs tested yet, not skipped
  | 'in_progress'   // some IOs tested, some untested
  | 'passed'        // all IOs tested, all passed
  | 'failed'        // all IOs tested, at least one failed
  | 'skipped'       // session moved on without finishing
  | 'no_ios'        // device exists in SVG but has no IO rows in DB

export interface IoSummary {
  id: number
  name: string
  description: string | null
  result: 'Passed' | 'Failed' | null
  comments: string | null
  ioDirection: 'input' | 'output' | 'analog_input' | 'analog_output' | null
}

export interface Device {
  /** Matches the `<g id>` in the SVG and `Ios.NetworkDeviceName` in DB. */
  deviceName: string
  /** Position in SVG document order (0-indexed). Used for "next" sequence. */
  order: number
  /** Counts derived from the Ios table for this device. */
  totalIos: number
  passedIos: number
  failedIos: number
  untestedIos: number
  state: DeviceState
}

export interface DeviceWithIos extends Device {
  ios: IoSummary[]
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/lib/guided/types.ts
git commit -m "feat(guided): add Device/DeviceState/IoSummary types

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: SVG parser (TDD)

**Files:**
- Create: `frontend/lib/guided/svg-parser.ts`
- Test: `frontend/__tests__/guided-svg-parser.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/__tests__/guided-svg-parser.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { parseDeviceIdsFromSvg } from '@/lib/guided/svg-parser'

describe('parseDeviceIdsFromSvg', () => {
  it('returns ids of <g> elements in document order', () => {
    const svg = `<?xml version="1.0"?>
      <svg>
        <g id="UL17_20_VFD"><rect/></g>
        <g id="UL17_21_VFD"><rect/></g>
        <g id="UL20_19_VFD"><rect/></g>
      </svg>`
    expect(parseDeviceIdsFromSvg(svg)).toEqual([
      'UL17_20_VFD',
      'UL17_21_VFD',
      'UL20_19_VFD',
    ])
  })

  it('ignores <g> elements without an id', () => {
    const svg = `<svg>
        <g id="A"/>
        <g><rect/></g>
        <g id="B"/>
      </svg>`
    expect(parseDeviceIdsFromSvg(svg)).toEqual(['A', 'B'])
  })

  it('returns empty array when SVG has no <g> elements with ids', () => {
    expect(parseDeviceIdsFromSvg('<svg><rect/></svg>')).toEqual([])
  })

  it('handles single-quoted ids', () => {
    const svg = `<svg><g id='X1'/><g id="X2"/></svg>`
    expect(parseDeviceIdsFromSvg(svg)).toEqual(['X1', 'X2'])
  })

  it('handles whitespace and newlines between attributes', () => {
    const svg = `<svg>
        <g
          inkscape:label="UL17_20_VFD"
          id="UL17_20_VFD"
          data-color="#000"
        ><rect/></g>
      </svg>`
    expect(parseDeviceIdsFromSvg(svg)).toEqual(['UL17_20_VFD'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd frontend && npm run test -- guided-svg-parser
```

Expected: tests fail with "Cannot find module '@/lib/guided/svg-parser'".

- [ ] **Step 3: Implement minimal parser**

Create `frontend/lib/guided/svg-parser.ts`:

```typescript
/**
 * Parse <g id="..."> elements out of an SVG string in document order.
 *
 * The SCADA team exports every device as a top-level <g> element with the
 * device name as the id (matches NetworkDeviceName in the local Ios table).
 * Their layout order on the SVG is the order they want operators to walk
 * the floor — we preserve it.
 *
 * Regex over a real XML parser is intentional: zero new deps, the SVGs are
 * machine-generated by Inkscape with predictable structure, and the only
 * thing we extract is the id attribute on <g> tags.
 */
export function parseDeviceIdsFromSvg(svg: string): string[] {
  const ids: string[] = []
  const re = /<g\b[^>]*\bid\s*=\s*(['"])([^'"]+)\1[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(svg)) !== null) {
    ids.push(m[2])
  }
  return ids
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd frontend && npm run test -- guided-svg-parser
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/guided/svg-parser.ts frontend/__tests__/guided-svg-parser.test.ts
git commit -m "feat(guided): SVG parser to extract device ids in document order

Pure regex over <g id=...> elements, no new deps. Matches SCADA-exported
SVG structure where every device is a top-level <g> whose id equals the
device name in the database.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Device-state derivation (TDD)

**Files:**
- Create: `frontend/lib/guided/device-state.ts`
- Test: `frontend/__tests__/guided-device-state.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/__tests__/guided-device-state.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import {
  computeDeviceState,
  findCurrentTarget,
} from '@/lib/guided/device-state'
import type { Device } from '@/lib/guided/types'

describe('computeDeviceState', () => {
  it('returns no_ios when device has zero IOs', () => {
    expect(
      computeDeviceState({ total: 0, passed: 0, failed: 0 }, false),
    ).toBe('no_ios')
  })

  it('returns untested when no IOs tested and not skipped', () => {
    expect(
      computeDeviceState({ total: 5, passed: 0, failed: 0 }, false),
    ).toBe('untested')
  })

  it('returns skipped when untested IOs remain and device is in skipped set', () => {
    expect(
      computeDeviceState({ total: 5, passed: 2, failed: 0 }, true),
    ).toBe('skipped')
  })

  it('returns in_progress when some tested and some untested and not skipped', () => {
    expect(
      computeDeviceState({ total: 5, passed: 2, failed: 0 }, false),
    ).toBe('in_progress')
    expect(
      computeDeviceState({ total: 5, passed: 0, failed: 1 }, false),
    ).toBe('in_progress')
  })

  it('returns passed when all IOs passed', () => {
    expect(
      computeDeviceState({ total: 3, passed: 3, failed: 0 }, false),
    ).toBe('passed')
  })

  it('returns failed when all IOs tested and at least one failed', () => {
    expect(
      computeDeviceState({ total: 3, passed: 2, failed: 1 }, false),
    ).toBe('failed')
  })

  it('passed takes precedence over skipped flag when nothing left untested', () => {
    expect(
      computeDeviceState({ total: 3, passed: 3, failed: 0 }, true),
    ).toBe('passed')
  })
})

describe('findCurrentTarget', () => {
  const make = (deviceName: string, order: number, state: Device['state']): Device => ({
    deviceName,
    order,
    totalIos: 1,
    passedIos: 0,
    failedIos: 0,
    untestedIos: 1,
    state,
  })

  it('picks first untested device by order', () => {
    const devices = [
      make('A', 0, 'passed'),
      make('B', 1, 'untested'),
      make('C', 2, 'untested'),
    ]
    expect(findCurrentTarget(devices)?.deviceName).toBe('B')
  })

  it('picks first in_progress when no untested remain before it', () => {
    const devices = [
      make('A', 0, 'passed'),
      make('B', 1, 'in_progress'),
      make('C', 2, 'untested'),
    ]
    expect(findCurrentTarget(devices)?.deviceName).toBe('B')
  })

  it('skips skipped and failed devices when picking next target', () => {
    const devices = [
      make('A', 0, 'failed'),
      make('B', 1, 'skipped'),
      make('C', 2, 'untested'),
    ]
    expect(findCurrentTarget(devices)?.deviceName).toBe('C')
  })

  it('returns null when every device is passed/failed/skipped/no_ios', () => {
    const devices = [
      make('A', 0, 'passed'),
      make('B', 1, 'failed'),
      make('C', 2, 'skipped'),
      make('D', 3, 'no_ios'),
    ]
    expect(findCurrentTarget(devices)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd frontend && npm run test -- guided-device-state
```

Expected: tests fail with "Cannot find module".

- [ ] **Step 3: Implement device-state functions**

Create `frontend/lib/guided/device-state.ts`:

```typescript
import type { Device, DeviceState } from './types'

interface Counts {
  total: number
  passed: number
  failed: number
}

/**
 * Derive a device's visual state from its IO test counts and whether the
 * current session has the device in its skipped set.
 */
export function computeDeviceState(counts: Counts, isSkipped: boolean): DeviceState {
  if (counts.total === 0) return 'no_ios'
  const tested = counts.passed + counts.failed
  const untested = counts.total - tested
  if (untested === 0) {
    return counts.failed > 0 ? 'failed' : 'passed'
  }
  if (isSkipped) return 'skipped'
  if (tested > 0) return 'in_progress'
  return 'untested'
}

/**
 * Pick the recommended next device for the operator: first device in SVG
 * document order whose state is `untested` or `in_progress`.
 *
 * Failed/skipped/no_ios devices are intentionally NOT auto-targeted — the
 * operator can still tap them if they want to retest, but the sequence
 * doesn't drag them back automatically.
 */
export function findCurrentTarget(devices: Device[]): Device | null {
  const sorted = [...devices].sort((a, b) => a.order - b.order)
  for (const d of sorted) {
    if (d.state === 'untested' || d.state === 'in_progress') return d
  }
  return null
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd frontend && npm run test -- guided-device-state
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/guided/device-state.ts frontend/__tests__/guided-device-state.test.ts
git commit -m "feat(guided): device state derivation and current-target picker

Pure functions over IO counts + skipped flag. State precedence: no_ios >
passed > failed > skipped > in_progress > untested. Current target =
first device in SVG order whose state is untested or in_progress.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: API route — serve the bundled SVG

**Files:**
- Create: `frontend/app/api/maps/subsystem/[id]/route.ts`
- Modify: `frontend/routes/index.ts`

- [ ] **Step 1: Write the route handler**

Create `frontend/app/api/maps/subsystem/[id]/route.ts`:

```typescript
import type { Request, Response } from 'express'
import { promises as fs } from 'fs'
import path from 'path'

/**
 * GET /api/maps/subsystem/:id
 *
 * Phase 1: serves the bundled MCM09 SVG regardless of subsystemId — there's
 * only one map shipped right now, every subsystem sees it. Phase 2 will
 * look the SVG up by subsystemId in the local SubsystemMaps table and fall
 * back to a cloud fetch if missing.
 *
 * Path resolution: Vite copies `public/*` into `dist/` at build time, and
 * `process.cwd()` differs between `npm run dev` (frontend/) and the
 * production runtime (dist-server/, with dist/ as a sibling). Try both.
 */
const SVG_CANDIDATES = [
  path.join(process.cwd(), 'public', 'maps', 'MCM09_Detailed_View.svg'), // dev
  path.join(process.cwd(), 'dist', 'maps', 'MCM09_Detailed_View.svg'),   // prod (after vite build)
]

export async function readBundledSvg(): Promise<string | null> {
  for (const p of SVG_CANDIDATES) {
    try {
      return await fs.readFile(p, 'utf-8')
    } catch {
      // try next candidate
    }
  }
  return null
}

export async function GET(_req: Request, res: Response) {
  const svg = await readBundledSvg()
  if (svg === null) {
    return res.status(404).json({ error: 'No map bundled for this subsystem' })
  }
  res.setHeader('Content-Type', 'image/svg+xml')
  res.setHeader('Cache-Control', 'no-cache')
  return res.send(svg)
}
```

- [ ] **Step 2: Mount the route in `routes/index.ts`**

Find the section in `frontend/routes/index.ts` where other `router.get('/api/...')` calls live (around the IO routes is fine). Add the import at the top of the file alongside the other `import * as` lines:

```typescript
import * as guidedMapById from '@/app/api/maps/subsystem/[id]/route'
```

Add the route registration in the same area as the other API mounts (alphabetical-ish; near the IO routes is fine):

```typescript
router.get('/api/maps/subsystem/:id', asyncHandler(guidedMapById.GET))
```

- [ ] **Step 3: Smoke-test manually**

Run the dev server:
```bash
cd frontend && npm run dev
```

In another terminal:
```bash
curl -i http://localhost:3000/api/maps/subsystem/1
```

Expected: HTTP 200, `Content-Type: image/svg+xml`, body starts with `<?xml version="1.0"`.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/api/maps/subsystem frontend/routes/index.ts
git commit -m "feat(guided): GET /api/maps/subsystem/:id returns bundled SVG

Phase 1 serves the same MCM09 SVG for every subsystemId. Phase 2 will
look up per-subsystem SVGs from the local SubsystemMaps table.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: API route — devices list with computed states

**Files:**
- Create: `frontend/app/api/guided/devices/route.ts`
- Modify: `frontend/routes/index.ts`

- [ ] **Step 1: Write the route handler**

Create `frontend/app/api/guided/devices/route.ts`:

```typescript
import type { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { parseDeviceIdsFromSvg } from '@/lib/guided/svg-parser'
import { computeDeviceState } from '@/lib/guided/device-state'
import { readBundledSvg } from '@/app/api/maps/subsystem/[id]/route'
import type { Device } from '@/lib/guided/types'

interface IoCountRow {
  deviceName: string
  total: number
  passed: number
  failed: number
}

/**
 * GET /api/guided/devices?subsystemId=...&skipped=A,B,C
 *
 * Returns the list of devices that appear in the bundled SVG, in document
 * order, joined to live IO counts from the local Ios table. Each device
 * is stamped with its computed state (untested / in_progress / passed /
 * failed / skipped / no_ios).
 *
 * `skipped` is an optional comma-separated list of device names the caller
 * has marked skipped this session. Phase 1 keeps this in React state and
 * passes it on every call — no DB persistence.
 */
export async function GET(req: Request, res: Response) {
  const subsystemIdRaw = req.query.subsystemId
  const subsystemId = typeof subsystemIdRaw === 'string'
    ? parseInt(subsystemIdRaw, 10)
    : NaN
  if (!subsystemId || isNaN(subsystemId) || subsystemId <= 0) {
    return res.status(400).json({ error: 'Valid subsystemId query param is required' })
  }

  const skippedRaw = req.query.skipped
  const skippedSet = new Set<string>(
    typeof skippedRaw === 'string' && skippedRaw.length > 0
      ? skippedRaw.split(',').map(s => s.trim()).filter(Boolean)
      : [],
  )

  const svg = await readBundledSvg()
  if (svg === null) {
    return res.status(500).json({ error: 'No bundled map available for ordering' })
  }

  const orderedIds = parseDeviceIdsFromSvg(svg)

  const rows = db.prepare(`
    SELECT NetworkDeviceName as deviceName,
           COUNT(*) as total,
           SUM(CASE WHEN Result = 'Passed' THEN 1 ELSE 0 END) as passed,
           SUM(CASE WHEN Result = 'Failed' THEN 1 ELSE 0 END) as failed
      FROM Ios
     WHERE SubsystemId = ?
       AND NetworkDeviceName IS NOT NULL
       AND NetworkDeviceName != ''
     GROUP BY NetworkDeviceName
  `).all(subsystemId) as IoCountRow[]

  const countsByName = new Map<string, IoCountRow>(
    rows.map(r => [r.deviceName, r]),
  )

  const devices: Device[] = orderedIds.map((deviceName, order) => {
    const counts = countsByName.get(deviceName) ?? { deviceName, total: 0, passed: 0, failed: 0 }
    const state = computeDeviceState(
      { total: counts.total, passed: counts.passed, failed: counts.failed },
      skippedSet.has(deviceName),
    )
    return {
      deviceName,
      order,
      totalIos: counts.total,
      passedIos: counts.passed,
      failedIos: counts.failed,
      untestedIos: counts.total - counts.passed - counts.failed,
      state,
    }
  })

  return res.json({ devices })
}
```

- [ ] **Step 2: Add device-detail route for the drawer**

Create `frontend/app/api/guided/devices/[name]/route.ts`:

```typescript
import type { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import type { IoSummary } from '@/lib/guided/types'

interface IoRow {
  id: number
  Name: string
  Description: string | null
  Result: string | null
  Comments: string | null
}

/**
 * GET /api/guided/devices/:name?subsystemId=...
 *
 * Returns the IOs belonging to a single device, with their current Result
 * values for display in the drawer. Read-only — no writes happen here.
 */
export async function GET(req: Request, res: Response) {
  const subsystemIdRaw = req.query.subsystemId
  const subsystemId = typeof subsystemIdRaw === 'string'
    ? parseInt(subsystemIdRaw, 10)
    : NaN
  if (!subsystemId || isNaN(subsystemId) || subsystemId <= 0) {
    return res.status(400).json({ error: 'Valid subsystemId query param is required' })
  }

  const deviceName = req.params.name
  if (!deviceName) {
    return res.status(400).json({ error: 'Device name is required' })
  }

  const rows = db.prepare(`
    SELECT id, Name, Description, Result, Comments
      FROM Ios
     WHERE SubsystemId = ?
       AND NetworkDeviceName = ?
     ORDER BY "Order", id
  `).all(subsystemId, deviceName) as IoRow[]

  const ios: IoSummary[] = rows.map(r => ({
    id: r.id,
    name: r.Name,
    description: r.Description,
    result: r.Result === 'Passed' || r.Result === 'Failed' ? r.Result as 'Passed' | 'Failed' : null,
    comments: r.Comments,
    ioDirection: null, // Phase 2: classify from name pattern using existing helper
  }))

  return res.json({ deviceName, ios })
}
```

- [ ] **Step 3: Mount both routes in `routes/index.ts`**

Add imports near the other `import * as` lines:

```typescript
import * as guidedDevices from '@/app/api/guided/devices/route'
import * as guidedDeviceByName from '@/app/api/guided/devices/[name]/route'
```

Add the route registrations near the other API mounts:

```typescript
router.get('/api/guided/devices', asyncHandler(guidedDevices.GET))
router.get('/api/guided/devices/:name', asyncHandler(guidedDeviceByName.GET))
```

- [ ] **Step 4: Smoke-test manually**

```bash
curl -s "http://localhost:3000/api/guided/devices?subsystemId=15" | head -c 400
```

Expected: JSON `{ "devices": [{ "deviceName": "UL17_20_VFD", "order": 0, "totalIos": ..., "state": ... }, ...] }`. The exact counts depend on what's currently in your local DB — that's fine, just confirm it returns devices in SVG order with non-empty fields.

```bash
curl -s "http://localhost:3000/api/guided/devices/UL17_20_VFD?subsystemId=15" | head -c 400
```

Expected: JSON `{ "deviceName": "UL17_20_VFD", "ios": [...] }`.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/api/guided/devices frontend/routes/index.ts
git commit -m "feat(guided): /api/guided/devices and /api/guided/devices/:name

Read-only endpoints for the guided UI. List endpoint returns SVG-document-
ordered devices with live IO counts and computed states. Detail endpoint
returns a single device's IOs for the drawer. No DB writes — Phase 1 is
prototype-only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Guided session reducer (TDD)

**Files:**
- Create: `frontend/lib/guided/use-guided-session.ts`
- Test: `frontend/__tests__/guided-session-reducer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/__tests__/guided-session-reducer.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { guidedReducer, initialGuidedState } from '@/lib/guided/use-guided-session'
import type { Device } from '@/lib/guided/types'

const dev = (deviceName: string, order: number): Device => ({
  deviceName,
  order,
  totalIos: 5,
  passedIos: 0,
  failedIos: 0,
  untestedIos: 5,
  state: 'untested',
})

describe('guidedReducer', () => {
  it('LOAD_DEVICES populates devices and clears loading', () => {
    const next = guidedReducer(
      { ...initialGuidedState, isLoading: true },
      { type: 'LOAD_DEVICES', devices: [dev('A', 0), dev('B', 1)] },
    )
    expect(next.devices.map(d => d.deviceName)).toEqual(['A', 'B'])
    expect(next.isLoading).toBe(false)
  })

  it('OPEN_DEVICE sets selectedDevice', () => {
    const next = guidedReducer(initialGuidedState, { type: 'OPEN_DEVICE', deviceName: 'A' })
    expect(next.selectedDevice).toBe('A')
  })

  it('CLOSE_DEVICE clears selectedDevice', () => {
    const next = guidedReducer(
      { ...initialGuidedState, selectedDevice: 'A' },
      { type: 'CLOSE_DEVICE' },
    )
    expect(next.selectedDevice).toBeNull()
  })

  it('SKIP_DEVICE adds to skipped set, closes drawer', () => {
    const next = guidedReducer(
      { ...initialGuidedState, selectedDevice: 'A' },
      { type: 'SKIP_DEVICE', deviceName: 'A' },
    )
    expect(next.skippedDevices.has('A')).toBe(true)
    expect(next.selectedDevice).toBeNull()
  })

  it('UNSKIP_DEVICE removes from skipped set', () => {
    const start = { ...initialGuidedState, skippedDevices: new Set(['A', 'B']) }
    const next = guidedReducer(start, { type: 'UNSKIP_DEVICE', deviceName: 'A' })
    expect(next.skippedDevices.has('A')).toBe(false)
    expect(next.skippedDevices.has('B')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd frontend && npm run test -- guided-session-reducer
```

Expected: tests fail with "Cannot find module".

- [ ] **Step 3: Implement the reducer + hook**

Create `frontend/lib/guided/use-guided-session.ts`:

```typescript
import { useCallback, useEffect, useReducer } from 'react'
import type { Device } from './types'

export interface GuidedState {
  isLoading: boolean
  devices: Device[]
  selectedDevice: string | null
  skippedDevices: Set<string>
  /** Bumped whenever something changes that requires a /api/guided/devices refetch. */
  refreshCounter: number
}

export const initialGuidedState: GuidedState = {
  isLoading: true,
  devices: [],
  selectedDevice: null,
  skippedDevices: new Set(),
  refreshCounter: 0,
}

export type GuidedAction =
  | { type: 'LOAD_START' }
  | { type: 'LOAD_DEVICES'; devices: Device[] }
  | { type: 'OPEN_DEVICE'; deviceName: string }
  | { type: 'CLOSE_DEVICE' }
  | { type: 'SKIP_DEVICE'; deviceName: string }
  | { type: 'UNSKIP_DEVICE'; deviceName: string }
  | { type: 'REFRESH' }

export function guidedReducer(state: GuidedState, action: GuidedAction): GuidedState {
  switch (action.type) {
    case 'LOAD_START':
      return { ...state, isLoading: true }
    case 'LOAD_DEVICES':
      return { ...state, isLoading: false, devices: action.devices }
    case 'OPEN_DEVICE':
      return { ...state, selectedDevice: action.deviceName }
    case 'CLOSE_DEVICE':
      return { ...state, selectedDevice: null }
    case 'SKIP_DEVICE': {
      const next = new Set(state.skippedDevices)
      next.add(action.deviceName)
      return {
        ...state,
        skippedDevices: next,
        selectedDevice: null,
        refreshCounter: state.refreshCounter + 1,
      }
    }
    case 'UNSKIP_DEVICE': {
      const next = new Set(state.skippedDevices)
      next.delete(action.deviceName)
      return { ...state, skippedDevices: next, refreshCounter: state.refreshCounter + 1 }
    }
    case 'REFRESH':
      return { ...state, refreshCounter: state.refreshCounter + 1 }
    default:
      return state
  }
}

/**
 * Hook that owns the guided-session UI state and fetches the device list.
 * Refetches whenever skippedDevices changes (passes them as a query param so
 * the API can stamp `skipped` state correctly).
 */
export function useGuidedSession(subsystemId: number) {
  const [state, dispatch] = useReducer(guidedReducer, initialGuidedState)

  useEffect(() => {
    let cancelled = false
    dispatch({ type: 'LOAD_START' })

    const skippedParam = Array.from(state.skippedDevices).join(',')
    const url = skippedParam.length > 0
      ? `/api/guided/devices?subsystemId=${subsystemId}&skipped=${encodeURIComponent(skippedParam)}`
      : `/api/guided/devices?subsystemId=${subsystemId}`

    fetch(url)
      .then(r => r.json())
      .then(data => {
        if (!cancelled) dispatch({ type: 'LOAD_DEVICES', devices: data.devices ?? [] })
      })
      .catch(err => {
        console.error('[GuidedSession] Failed to load devices:', err)
        if (!cancelled) dispatch({ type: 'LOAD_DEVICES', devices: [] })
      })

    return () => { cancelled = true }
  }, [subsystemId, state.refreshCounter])

  const openDevice = useCallback((deviceName: string) => dispatch({ type: 'OPEN_DEVICE', deviceName }), [])
  const closeDevice = useCallback(() => dispatch({ type: 'CLOSE_DEVICE' }), [])
  const skipDevice = useCallback((deviceName: string) => dispatch({ type: 'SKIP_DEVICE', deviceName }), [])
  const unskipDevice = useCallback((deviceName: string) => dispatch({ type: 'UNSKIP_DEVICE', deviceName }), [])

  return { state, openDevice, closeDevice, skipDevice, unskipDevice }
}
```

- [ ] **Step 4: Run test to verify reducer passes**

```bash
cd frontend && npm run test -- guided-session-reducer
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/guided/use-guided-session.ts frontend/__tests__/guided-session-reducer.test.ts
git commit -m "feat(guided): useGuidedSession hook + reducer

Owns the drawer + skipped-set + device-list state. Refetches devices on
skip changes so the API can stamp the 'skipped' state correctly. Phase 1:
all state is in-memory, no persistence.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Color CSS for SVG device states

**Files:**
- Create: `frontend/components/guided/guided-mode.css`

- [ ] **Step 1: Write the stylesheet**

Create `frontend/components/guided/guided-mode.css`:

```css
/* Color rules for SVG device <g> elements based on data-status attribute.
 * Bold, saturated for factory lighting. The map injects data-status onto
 * each <g id="..."> element after the SVG is loaded.
 *
 * The :where() wrapper keeps specificity low so existing inline fill/stroke
 * attributes on the rect/path inside the <g> are overridden.
 */

.guided-svg :where(g[data-status] rect, g[data-status] path) {
  transition: fill 200ms ease, stroke 200ms ease;
}

/* untested: light gray fill, dark gray stroke */
.guided-svg g[data-status="untested"] :where(rect, path) {
  fill: #f5f5f5;
  stroke: #475569;
  stroke-width: 1.5;
}

/* in_progress: amber */
.guided-svg g[data-status="in_progress"] :where(rect, path) {
  fill: #fcd34d;
  stroke: #b45309;
  stroke-width: 1.5;
}

/* passed: saturated green */
.guided-svg g[data-status="passed"] :where(rect, path) {
  fill: #4ade80;
  stroke: #166534;
  stroke-width: 1.5;
}

/* failed: bold red */
.guided-svg g[data-status="failed"] :where(rect, path) {
  fill: #f87171;
  stroke: #991b1b;
  stroke-width: 1.5;
}

/* skipped: striped gray (uses repeating-linear-gradient pattern via SVG defs is overkill for v1; use mid-gray with dashed stroke) */
.guided-svg g[data-status="skipped"] :where(rect, path) {
  fill: #cbd5e1;
  stroke: #64748b;
  stroke-width: 1.5;
  stroke-dasharray: 4 3;
}

/* no_ios: muted, slightly transparent */
.guided-svg g[data-status="no_ios"] :where(rect, path) {
  fill: #e5e7eb;
  stroke: #9ca3af;
  stroke-width: 1;
  opacity: 0.6;
}

/* current target: bright pulsing blue outline (independent of state) */
.guided-svg g[data-current="true"] :where(rect, path) {
  stroke: #2563eb;
  stroke-width: 3;
  animation: guided-pulse 1.6s ease-in-out infinite;
}

@keyframes guided-pulse {
  0%, 100% { stroke-opacity: 1; }
  50% { stroke-opacity: 0.45; }
}

/* hover/click affordance — slight elevation */
.guided-svg g[data-status]:not([data-status="no_ios"]) {
  cursor: pointer;
}

.guided-svg g[data-status]:not([data-status="no_ios"]):hover :where(rect, path) {
  filter: brightness(1.05);
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/components/guided/guided-mode.css
git commit -m "style(guided): SVG device color states keyed by data-status

Bold/saturated for factory lighting. Pulsing blue stroke for current
target via data-current. Skipped uses dashed stroke. No-ios devices
muted to communicate inert.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: GuidedTestingMap component

**Files:**
- Create: `frontend/components/guided/guided-testing-map.tsx`

- [ ] **Step 1: Write the map component**

Create `frontend/components/guided/guided-testing-map.tsx`:

```tsx
import { useEffect, useRef } from 'react'
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch'
import type { Device } from '@/lib/guided/types'
import './guided-mode.css'

interface Props {
  /** Raw SVG markup loaded from /api/maps/subsystem/:id */
  svgMarkup: string
  /** Devices in SVG order with computed state. */
  devices: Device[]
  /** Device whose pulsing-blue outline is the recommended next, or null. */
  currentTarget: Device | null
  /** Called when an interactive device is clicked. */
  onDeviceClick: (deviceName: string) => void
}

/**
 * Renders the SCADA SVG full-screen with pan/zoom, then walks the live DOM
 * to set `data-status` (and `data-current` on the current target) on each
 * <g> matching a known device. Click delegation is on the container; we
 * inspect `event.target.closest('g[data-status]')` to find which device.
 */
export function GuidedTestingMap({ svgMarkup, devices, currentTarget, onDeviceClick }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  // After the SVG is in the DOM, stamp data-status on each <g> from the device list.
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    const stateByName = new Map(devices.map(d => [d.deviceName, d.state]))

    const groups = root.querySelectorAll<SVGGElement>('svg g[id]')
    groups.forEach(g => {
      const id = g.getAttribute('id')
      if (!id) return
      const state = stateByName.get(id)
      if (state) {
        g.setAttribute('data-status', state)
      } else {
        g.setAttribute('data-status', 'no_ios')
      }
    })
  }, [svgMarkup, devices])

  // Mark current target with data-current="true"
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    root.querySelectorAll('svg g[data-current]').forEach(g => g.removeAttribute('data-current'))
    if (currentTarget) {
      const g = root.querySelector(`svg g[id="${CSS.escape(currentTarget.deviceName)}"]`)
      g?.setAttribute('data-current', 'true')
    }
  }, [currentTarget])

  // Click delegation
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    function handleClick(e: Event) {
      const target = e.target as Element
      const group = target.closest('g[data-status]') as SVGGElement | null
      if (!group) return
      const status = group.getAttribute('data-status')
      if (status === 'no_ios') return
      const id = group.getAttribute('id')
      if (id) onDeviceClick(id)
    }
    root.addEventListener('click', handleClick)
    return () => root.removeEventListener('click', handleClick)
  }, [onDeviceClick])

  return (
    <div className="w-full h-full bg-slate-50 overflow-hidden">
      <TransformWrapper
        minScale={0.3}
        maxScale={4}
        initialScale={0.6}
        centerOnInit
        doubleClick={{ disabled: true }}
        wheel={{ step: 0.1 }}
      >
        <TransformComponent
          wrapperStyle={{ width: '100%', height: '100%' }}
          contentStyle={{ width: '100%', height: '100%' }}
        >
          <div
            ref={containerRef}
            className="guided-svg"
            // Trusted source: bundled file we ship; SVG content is from our own SCADA exports.
            dangerouslySetInnerHTML={{ __html: svgMarkup }}
          />
        </TransformComponent>
      </TransformWrapper>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/components/guided/guided-testing-map.tsx
git commit -m "feat(guided): GuidedTestingMap renders SVG with state coloring

Injects raw SVG, stamps data-status per device from props, marks current
target with data-current. Click delegation finds the nearest g[data-status]
ancestor. Pan/zoom via react-zoom-pan-pinch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: DeviceTestPanel drawer

**Files:**
- Create: `frontend/components/guided/device-test-panel.tsx`

- [ ] **Step 1: Write the drawer component**

Create `frontend/components/guided/device-test-panel.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { X, SkipForward, Check, AlertCircle, CircleDashed } from 'lucide-react'
import type { Device, IoSummary } from '@/lib/guided/types'

interface Props {
  device: Device
  subsystemId: number
  onClose: () => void
  onSkip: (deviceName: string) => void
}

interface IoLocalState {
  /** Optimistic in-memory result that overrides the DB-loaded result for visual feedback only. */
  uiResult: 'Passed' | 'Failed' | null
}

/**
 * Right-side drawer that lists a device's IOs and lets the operator click
 * Pass / Fail / Skip. PHASE 1: all interactions are visual only — no DB
 * writes, no /api/test calls, no PLC writes. Toasts confirm the click.
 */
export function DeviceTestPanel({ device, subsystemId, onClose, onSkip }: Props) {
  const [ios, setIos] = useState<IoSummary[] | null>(null)
  const [localState, setLocalState] = useState<Record<number, IoLocalState>>({})

  useEffect(() => {
    let cancelled = false
    fetch(`/api/guided/devices/${encodeURIComponent(device.deviceName)}?subsystemId=${subsystemId}`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled) setIos(data.ios ?? [])
      })
      .catch(err => {
        console.error('[DeviceTestPanel] Failed to load device IOs:', err)
        if (!cancelled) setIos([])
      })
    return () => { cancelled = true }
  }, [device.deviceName, subsystemId])

  function effectiveResult(io: IoSummary): 'Passed' | 'Failed' | null {
    return localState[io.id]?.uiResult ?? io.result
  }

  function markPass(ioId: number) {
    setLocalState(s => ({ ...s, [ioId]: { uiResult: 'Passed' } }))
  }
  function markFail(ioId: number) {
    setLocalState(s => ({ ...s, [ioId]: { uiResult: 'Failed' } }))
  }

  // Find the first untested IO (effective) — the "current IO" within the device.
  const currentIo = ios?.find(io => effectiveResult(io) === null) ?? null

  return (
    <aside className="fixed right-0 top-0 h-full w-[420px] bg-white border-l shadow-2xl z-30 flex flex-col">
      {/* Header */}
      <div className="px-4 py-3 border-b flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold truncate">{device.deviceName}</h2>
          <p className="text-xs text-muted-foreground">
            {device.passedIos + device.failedIos} of {device.totalIos} tested
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => onSkip(device.deviceName)}>
          <SkipForward className="w-4 h-4 mr-1" /> Skip
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="w-4 h-4" />
        </Button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {ios === null && <div className="text-sm text-muted-foreground">Loading IOs…</div>}
        {ios !== null && ios.length === 0 && (
          <div className="text-sm text-muted-foreground">No IOs configured for this device.</div>
        )}

        {currentIo && (
          <div className="border-2 border-blue-500 rounded-lg p-4 bg-blue-50">
            <div className="text-xs text-blue-700 font-semibold mb-1">CURRENT IO</div>
            <div className="font-mono text-sm font-bold">{currentIo.name}</div>
            {currentIo.description && (
              <div className="text-xs text-muted-foreground mt-1">{currentIo.description}</div>
            )}
            <div className="flex gap-2 mt-3">
              <Button size="sm" onClick={() => markPass(currentIo.id)}>
                <Check className="w-4 h-4 mr-1" /> Pass
              </Button>
              <Button size="sm" variant="destructive" onClick={() => markFail(currentIo.id)}>
                <AlertCircle className="w-4 h-4 mr-1" /> Fail
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-2 italic">
              Phase 1: marks visually only. No DB or PLC writes.
            </p>
          </div>
        )}

        {ios && ios.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs uppercase text-muted-foreground font-semibold">All IOs</div>
            {ios.map(io => {
              const r = effectiveResult(io)
              const Icon = r === 'Passed' ? Check : r === 'Failed' ? AlertCircle : CircleDashed
              const colorClass = r === 'Passed' ? 'text-green-600'
                : r === 'Failed' ? 'text-red-600' : 'text-muted-foreground'
              return (
                <div key={io.id} className="flex items-center gap-2 text-sm py-1">
                  <Icon className={`w-4 h-4 shrink-0 ${colorClass}`} />
                  <span className="font-mono text-xs truncate flex-1">{io.name}</span>
                  {r === null && currentIo?.id !== io.id && (
                    <Button size="sm" variant="outline" onClick={() => markPass(io.id)}>
                      Pass
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </aside>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/components/guided/device-test-panel.tsx
git commit -m "feat(guided): DeviceTestPanel drawer with current IO + Pass/Fail/Skip

Phase 1 visual prototype. Pass/Fail click updates local React state only —
no DB writes, no /api/test calls. Skip notifies parent which advances the
session. Drawer fetches the device's IOs from /api/guided/devices/:name
on open.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Page wrapper + route + entry point

**Files:**
- Create: `frontend/components/guided/guided-mode-page.tsx`
- Create: `frontend/app/commissioning/[id]/guided/page.tsx`
- Modify: `frontend/src/router.tsx`
- Modify: existing commissioning page to add a "Guided Mode" button (find the right header file in step 4)

- [ ] **Step 1: Write the page wrapper**

Create `frontend/components/guided/guided-mode-page.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, MapPin } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useGuidedSession } from '@/lib/guided/use-guided-session'
import { findCurrentTarget } from '@/lib/guided/device-state'
import { GuidedTestingMap } from './guided-testing-map'
import { DeviceTestPanel } from './device-test-panel'

export function GuidedModePage() {
  const { id } = useParams<{ id: string }>()
  const subsystemId = id ? parseInt(id, 10) : NaN
  const [svgMarkup, setSvgMarkup] = useState<string | null>(null)
  const { state, openDevice, closeDevice, skipDevice } = useGuidedSession(subsystemId)

  useEffect(() => {
    if (!subsystemId || isNaN(subsystemId)) return
    let cancelled = false
    fetch(`/api/maps/subsystem/${subsystemId}`)
      .then(r => r.text())
      .then(text => { if (!cancelled) setSvgMarkup(text) })
      .catch(err => {
        console.error('[GuidedModePage] Failed to load SVG:', err)
        if (!cancelled) setSvgMarkup('')
      })
    return () => { cancelled = true }
  }, [subsystemId])

  const currentTarget = findCurrentTarget(state.devices)
  const selectedDevice = state.selectedDevice
    ? state.devices.find(d => d.deviceName === state.selectedDevice) ?? null
    : null

  const totals = state.devices.reduce((acc, d) => {
    acc[d.state] = (acc[d.state] ?? 0) + 1
    return acc
  }, {} as Record<string, number>)
  const completed = (totals.passed ?? 0) + (totals.failed ?? 0)
  const total = state.devices.length

  if (!subsystemId || isNaN(subsystemId)) {
    return <div className="p-8">Invalid subsystem id</div>
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-background">
      {/* Header */}
      <header className="h-12 border-b flex items-center px-3 gap-3 shrink-0">
        <Button asChild variant="ghost" size="sm">
          <Link to={`/commissioning/${subsystemId}`}>
            <ArrowLeft className="w-4 h-4 mr-1" /> Back
          </Link>
        </Button>
        <div className="text-sm font-semibold">Guided · Subsystem {subsystemId}</div>
        <div className="flex-1 flex justify-center">
          <div className="text-xs text-muted-foreground">
            {completed} / {total} done
            {totals.in_progress ? ` · ${totals.in_progress} in progress` : ''}
            {totals.skipped ? ` · ${totals.skipped} skipped` : ''}
            {totals.failed ? ` · ${totals.failed} failed` : ''}
          </div>
        </div>
        <div className="text-[10px] uppercase text-amber-600 font-semibold">Prototype · no writes</div>
      </header>

      {/* Body */}
      <main className="flex-1 relative overflow-hidden">
        {state.isLoading || svgMarkup === null ? (
          <div className="h-full flex items-center justify-center text-muted-foreground">Loading map…</div>
        ) : svgMarkup === '' ? (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            No map available for this subsystem.
          </div>
        ) : (
          <GuidedTestingMap
            svgMarkup={svgMarkup}
            devices={state.devices}
            currentTarget={currentTarget}
            onDeviceClick={openDevice}
          />
        )}

        {/* Floating Next chip */}
        {currentTarget && !selectedDevice && (
          <button
            type="button"
            onClick={() => openDevice(currentTarget.deviceName)}
            className="absolute bottom-4 right-4 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-full shadow-lg flex items-center gap-2 text-sm font-semibold"
          >
            <MapPin className="w-4 h-4" />
            Next: {currentTarget.deviceName}
            <span aria-hidden>→</span>
          </button>
        )}

        {/* Drawer */}
        {selectedDevice && (
          <DeviceTestPanel
            device={selectedDevice}
            subsystemId={subsystemId}
            onClose={closeDevice}
            onSkip={skipDevice}
          />
        )}
      </main>
    </div>
  )
}
```

- [ ] **Step 2: Create the route page**

Create `frontend/app/commissioning/[id]/guided/page.tsx`:

```tsx
import { GuidedModePage } from '@/components/guided/guided-mode-page'

export default function Page() {
  return <GuidedModePage />
}
```

- [ ] **Step 3: Add the route to the router**

Modify `frontend/src/router.tsx` — add the lazy import and the route entry. Below the existing imports, add:

```tsx
const GuidedPage = lazy(() => import('../app/commissioning/[id]/guided/page'))
```

In the `createBrowserRouter([…])` array, add this entry **before** `{ path: '/commissioning/:id', … }` so the more specific path matches first:

```tsx
  { path: '/commissioning/:id/guided', element: <LazyPage Component={GuidedPage} /> },
```

- [ ] **Step 4: Add the entry-point button on the existing commissioning page**

The exact file housing the existing commissioning toolbar is large; locate it once and add a button. Run:

```bash
grep -n "PLC Configuration\|plc-toolbar\|Commissioning -\|<h1" frontend/components/plc-toolbar.tsx frontend/app/commissioning/\[id\]/page.tsx 2>/dev/null | head -20
```

Pick whichever file holds the existing top-row toolbar/buttons (most likely `frontend/components/plc-toolbar.tsx`). Add a button that links to the guided page. Example pattern (insert it next to the other top-toolbar buttons, **adapt the surrounding markup to match the existing buttons in that file**):

```tsx
import { Link, useParams } from 'react-router-dom'
import { Map } from 'lucide-react'
// …

const { id } = useParams<{ id: string }>()
// …

{/* New: Guided mode entry */}
<Button asChild variant="outline" size="sm">
  <Link to={`/commissioning/${id}/guided`}>
    <Map className="w-4 h-4 mr-1" /> Guided Mode
  </Link>
</Button>
```

If `useParams` is not in scope where you place the button, derive `id` from the surrounding component's props or from `useLocation().pathname` — match the pattern used by the file's other buttons.

- [ ] **Step 5: Commit**

```bash
git add frontend/components/guided/guided-mode-page.tsx \
        frontend/app/commissioning/\[id\]/guided/page.tsx \
        frontend/src/router.tsx \
        frontend/components/plc-toolbar.tsx
git commit -m "feat(guided): page wrapper + /commissioning/:id/guided route + toolbar button

Composes GuidedTestingMap + DeviceTestPanel + header + floating Next chip.
'Guided Mode' button on the existing commissioning toolbar opens the new
route. Existing manual-grid page is untouched.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Manual smoke test

**Files:** none changed — verification only.

- [ ] **Step 1: Run the dev server**

```bash
cd frontend && npm run dev
```

Open `http://localhost:5173` (Vite dev port).

- [ ] **Step 2: Navigate to a subsystem with IOs**

Use the URL bar: `http://localhost:5173/commissioning/15` (or whichever subsystemId your local DB has IOs for — check via the existing commissioning page).

Click the **"Guided Mode"** button you added in Task 11.

You should land on `/commissioning/15/guided`.

- [ ] **Step 3: Verify visual state**

- [ ] SVG renders the MCM09 layout, fills the screen.
- [ ] Pan with click-drag (mouse) and pinch (touch) works.
- [ ] Zoom with scroll wheel works.
- [ ] Each VFD shape is colored by its current IO state — devices that already have all IOs passed should be green, untested ones gray.
- [ ] One device pulses with a blue outline (current target).
- [ ] Bottom-right shows a "Next: UL…_VFD →" chip.
- [ ] Header shows "X / Y done" with whatever counts your DB has.

- [ ] **Step 4: Verify drawer interactions**

- [ ] Click any colored device → drawer opens on the right with that device's IOs.
- [ ] The first untested IO is highlighted as "CURRENT IO" with Pass/Fail buttons.
- [ ] Click **Pass** on the current IO → it gets a green check, the next untested IO becomes "CURRENT IO".
- [ ] Click **Fail** on a current IO → it gets a red X, next IO becomes current.
- [ ] Click **Skip** in the header → drawer closes, device shows as `skipped` (dashed gray).
- [ ] Click **X** to close drawer without skipping → drawer closes, device state unchanged.

- [ ] **Step 5: Verify zero data is mutated**

Open the local SQLite DB (`database.db`) in another terminal:
```bash
sqlite3 frontend/database.db "SELECT id, Name, Result FROM Ios WHERE NetworkDeviceName = 'UL17_20_VFD' LIMIT 5;"
```

Compare before and after clicking Pass/Fail in the drawer — `Result` column values **must not change**. The drawer's visual state is React-only.

- [ ] **Step 6: Verify no regressions in manual mode**

Click **Back** in the guided header (or navigate manually to `/commissioning/15`). The existing manual-grid commissioning page must render exactly as before.

- [ ] **Step 7: If everything checks out, commit any final tweaks**

```bash
git status
# If clean, no commit needed.
# If you made small CSS / wording fixes during smoke test:
git add -p
git commit -m "chore(guided): smoke-test polish

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 1 Done — what you have

- A new `/commissioning/:id/guided` route that loads the bundled MCM09 SVG and color-codes each VFD by its current IO state.
- A drawer that opens on click, shows the device's IOs, and lets the operator click Pass/Fail/Skip with **visual-only feedback** — zero DB writes, zero PLC writes, zero `/api/test` calls.
- Pan/zoom on tablet and desktop.
- Recommended-next sequence based on SVG document order, with a floating chip to jump to it.
- Skip-and-return: skipped devices show striped gray, sequence advances past them.
- Existing manual mode and active cloud users untouched.

## Phase 2 (deferred — captured in `2026-04-28-guided-mode-svg-design.md`)

- Cloud-side `SubsystemMaps` table, admin upload UI, sync endpoint.
- Local `SubsystemMaps` table populated by `/api/cloud/pull`.
- Wire Pass/Fail/Skip to real `/api/ios/:id/test` and `/api/guided/session/*` persistence.
- PLC tag-trigger WebSocket → auto-pass + swap detection (reuses kept services).
