# Roadmap-driven Guided Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fully scripted walkdown experience: supervisor authors a sequence of steps with instruction text and a drawn walking path in the Cloud admin UI; the field tool plays it back step-by-step in Guided Mode with the map locked to one target at a time.

**Architecture:** Mirrors the existing `McmDiagram` pattern. A new `Roadmap` Postgres table in `commissioning-cloud` is authored at `/admin/roadmaps` and synced via `GET /api/sync/roadmaps`. The local field tool mirrors it into a `Roadmaps` SQLite table via `POST /api/cloud/pull-roadmap` and plays it inside the existing `/commissioning/:id/guided` route as a new "Roadmap" entry in the `FlowModeChip` dropdown.

**Tech Stack:**
- Cloud: Next.js 14 App Router, Prisma + Postgres, Zod, NextAuth (Azure AD + access-key), shadcn/ui (existing).
- Local: Express 5 + TypeScript, Vite + React 18, better-sqlite3, react-zoom-pan-pinch (existing), Vitest.

**Spec:** `frontend/specs/2026-05-16-roadmap-guided-mode-design.md`

**Branches (already created — do all work on these, do NOT merge to main):**
- `commissioning-cloud` → `feat/roadmap-guided-mode`
- `commissioning-local/frontend` → `feat/roadmap-guided-mode`

**Repo prefix convention:** task headings are prefixed `[CLOUD]` (work inside `commissioning-cloud/`) or `[LOCAL]` (work inside `commissioning-local/frontend/`). All paths in tasks are relative to that repo root.

---

## File Structure

### Cloud (`commissioning-cloud/`)

| Path | Responsibility |
|---|---|
| `prisma/schema.prisma` | + `Roadmap` model |
| `lib/roadmap-schema.ts` | Zod schemas for `RoadmapStep`, `RoadmapPath` (single source of truth) |
| `lib/roadmap-auth.ts` | shared `requireAdmin()` helper (extract from existing pattern) |
| `app/api/sync/roadmaps/route.ts` | `GET ?subsystemId=N` — field-tool-facing, X-API-Key auth, rate-limited |
| `app/api/admin/roadmaps/route.ts` | `GET ?projectId=&mcm=` (list), `POST` (create empty) |
| `app/api/admin/roadmaps/[id]/route.ts` | `GET` (fetch), `PUT` (update), `DELETE` |
| `app/api/admin/roadmaps/[id]/publish/route.ts` | `PATCH` `{ isPublished: boolean }` |
| `app/api/admin/diagrams/by-mcm/route.ts` | `GET ?projectId=&mcm=` — returns SVG for the editor canvas |
| `app/api/admin/devices/route.ts` | `GET ?projectId=&mcm=&device=` — devices on the MCM (and per-device IOs when `device=` is set) |
| `app/admin/roadmaps/page.tsx` | list page |
| `app/admin/roadmaps/[id]/page.tsx` | editor page |
| `components/roadmap-editor.tsx` | editor composition |
| `components/roadmap-svg-canvas.tsx` | SVG renderer + click + draw handlers |
| `components/roadmap-step-list.tsx` | right-side step editor |
| `components/roadmap-mode-toolbar.tsx` | Add Steps / Draw Path switcher |

### Local (`commissioning-local/frontend/`)

| Path | Responsibility |
|---|---|
| `lib/db-sqlite.ts` (modify) | + `Roadmaps` table bootstrap |
| `lib/guided/roadmap-types.ts` | TS types + Zod schemas (mirrors cloud) |
| `lib/guided/roadmap-advance.ts` | `shouldAdvanceStep()` pure logic |
| `lib/guided/use-roadmap-session.ts` | reducer + hook |
| `app/api/cloud/pull-roadmap/route.ts` | mirrors `pull-mcm-diagram` |
| `app/api/roadmap/route.ts` | local cache read |
| `routes/index.ts` (modify) | mount the two new local routes |
| `components/guided/guided-mode-page.tsx` (modify) | compose roadmap state, enable FlowModeChip item |
| `components/guided/guided-testing-map.tsx` (modify) | accept `lockedDevices` prop |
| `components/guided/guided-mode.css` (modify) | banner / locked / path rules |
| `components/guided/roadmap-playback-banner.tsx` | bottom overlay |
| `components/guided/roadmap-path-overlay.tsx` | path arrows |
| `components/guided/roadmap-picker.tsx` | roadmap `<select>` |
| `__tests__/roadmap-advance.test.ts` | TDD |
| `__tests__/roadmap-session-reducer.test.ts` | TDD |
| `__tests__/roadmap-types-validation.test.ts` | TDD |

---

## Phase 1 — Cloud foundation (DB + APIs)

### Task 1: [CLOUD] Add the `Roadmap` Prisma model

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add the model**

Find the `model McmDiagram` block in `prisma/schema.prisma`. Immediately after its closing `}`, append:

```prisma
// One authored walkdown route for a given (project, mcm). Steps and path are
// stored as JSON for schema flexibility; both are Zod-validated on every
// write. Multiple roadmaps allowed per (project, mcm) so supervisors can
// author different walks (EPC-only, VFD-only, pre-energize, etc).
model Roadmap {
  id          Int      @id @default(autoincrement())
  projectId   Int      @map("project_id")
  mcm         String   @db.VarChar(64)
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

Then find `model Project { ... }` and inside the relations block (where `mcmDiagrams McmDiagram[]` lives), append a sibling line:

```prisma
  roadmaps          Roadmap[]
```

- [ ] **Step 2: Generate client and push to dev DB**

```bash
npx prisma generate
npx prisma db push
```

Expected: `prisma generate` finishes silently. `db push` reports "Your database is now in sync with your Prisma schema." with a `roadmaps` table created.

- [ ] **Step 3: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(roadmap): add Roadmap Prisma model

One row per authored walkdown route; stepsJson + pathJson held as JSON
with Zod validation enforced at the API layer. Indexed on (projectId, mcm).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: [CLOUD] Zod schemas for steps and path

**Files:**
- Create: `lib/roadmap-schema.ts`

- [ ] **Step 1: Write the file**

```ts
import { z } from 'zod'

// One step in a roadmap. Every step targets a device; a step is "io-grained"
// when ioName is set (Pass/Fail of that single IO ends the step) and
// "device-grained" otherwise (all IOs on the device must be tested).
export const RoadmapStepSchema = z.object({
  order: z.number().int().min(1),
  kind: z.enum(['device', 'io']),
  deviceName: z.string().min(1).max(120),
  ioName: z.string().min(1).max(120).optional(),
  instructionText: z.string().min(1).max(500),
  transitText: z.string().max(200).optional(),
}).refine(
  s => s.kind === 'device' || (s.kind === 'io' && !!s.ioName),
  { message: 'ioName is required when kind === "io"', path: ['ioName'] },
)

export type RoadmapStep = z.infer<typeof RoadmapStepSchema>

export const RoadmapPathSegmentSchema = z.object({
  fromStep: z.number().int().min(1).optional(),
  toStep: z.number().int().min(1).optional(),
  points: z.array(z.object({ x: z.number(), y: z.number() })).min(2),
  style: z.enum(['arrow', 'dashed']).optional(),
})

export const RoadmapPathSchema = z.object({
  segments: z.array(RoadmapPathSegmentSchema),
})

export type RoadmapPath = z.infer<typeof RoadmapPathSchema>

// Body shapes for the admin routes
export const CreateRoadmapBodySchema = z.object({
  projectId: z.number().int().positive(),
  mcm: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
})

export const UpdateRoadmapBodySchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional().nullable(),
  steps: z.array(RoadmapStepSchema).min(0),
  path: RoadmapPathSchema.nullable().optional(),
})

export const PublishRoadmapBodySchema = z.object({
  isPublished: z.boolean(),
})
```

- [ ] **Step 2: Confirm tsc is clean**

```bash
npx tsc --noEmit
```

Expected: no errors (existing project may have unrelated warnings; this file should not introduce any).

- [ ] **Step 3: Commit**

```bash
git add lib/roadmap-schema.ts
git commit -m "feat(roadmap): Zod schemas for steps + path

Single source of truth for request body shapes; mirrored TS-only on the
local field tool side.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: [CLOUD] Sync endpoint `GET /api/sync/roadmaps`

**Files:**
- Create: `app/api/sync/roadmaps/route.ts`

- [ ] **Step 1: Write the route**

Pattern mirrors `app/api/sync/mcm-diagram/route.ts` exactly.

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

/**
 * GET /api/sync/roadmaps?subsystemId=N
 *
 * Returns all PUBLISHED roadmaps for the MCM that owns this subsystem. The
 * local field tool calls this to populate its local Roadmaps cache.
 *
 * Resolution mirrors /api/sync/mcm-diagram: Subsystem.name is the MCM
 * identifier; we look up roadmaps for that (projectId, mcm) pair.
 *
 * Auth: per-project API key via X-API-Key header.
 */
export async function GET(request: NextRequest) {
  try {
    const apiKey = request.headers.get('X-API-Key') ||
                   request.nextUrl.searchParams.get('apiKey')
    if (!apiKey) {
      return NextResponse.json({ error: 'API key required' }, { status: 401 })
    }

    const rateLimit = checkRateLimit(`sync:roadmaps:${apiKey}`, RATE_LIMITS.api)
    if (!rateLimit.success) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        { status: 429, headers: { 'Retry-After': '60' } },
      )
    }

    const subsystemIdStr = request.nextUrl.searchParams.get('subsystemId')
    const subsystemId = subsystemIdStr ? parseInt(subsystemIdStr, 10) : NaN
    if (!Number.isInteger(subsystemId) || subsystemId <= 0) {
      return NextResponse.json({ error: 'subsystemId required (positive integer)' }, { status: 400 })
    }

    const subsystem = await prisma.subsystem.findUnique({
      where: { id: subsystemId },
      include: { project: true },
    })
    if (!subsystem?.project) {
      return NextResponse.json({ error: 'Subsystem not found' }, { status: 404 })
    }
    if (subsystem.project.apiKey !== apiKey) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

    const mcm = subsystem.name
    if (!mcm) {
      return NextResponse.json({
        success: true, mcm: null, roadmaps: [],
        message: 'Subsystem has no name — cannot resolve MCM identifier',
      })
    }

    const rows = await prisma.roadmap.findMany({
      where: { projectId: subsystem.project.id, mcm, isPublished: true },
      orderBy: { updatedAt: 'desc' },
    })

    return NextResponse.json({
      success: true,
      mcm,
      roadmaps: rows.map(r => ({
        id: r.id,
        projectId: r.projectId,
        mcm: r.mcm,
        name: r.name,
        description: r.description,
        stepsJson: r.stepsJson,
        pathJson: r.pathJson,
        isPublished: r.isPublished,
        updatedAt: r.updatedAt.toISOString(),
      })),
    })
  } catch (error) {
    console.error('[Sync Roadmaps] Error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch roadmaps' },
      { status: 500 },
    )
  }
}
```

- [ ] **Step 2: Smoke-test**

Run cloud dev: `npm run dev` (port 3003). In another terminal:

```bash
curl -s "http://localhost:3003/api/sync/roadmaps?subsystemId=1" -H "X-API-Key: BAD" -o -
```

Expected: HTTP 401 or 403 (no API key match). Replace `BAD` with a real per-project apiKey from your dev DB to see `{ success: true, mcm: ..., roadmaps: [] }`.

- [ ] **Step 3: Commit**

```bash
git add app/api/sync/roadmaps/route.ts
git commit -m "feat(roadmap): GET /api/sync/roadmaps for field-tool pull

Returns published roadmaps for the subsystem's MCM. Mirrors the auth +
rate-limit pattern from /api/sync/mcm-diagram.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: [CLOUD] Admin list + create `/api/admin/roadmaps`

**Files:**
- Create: `app/api/admin/roadmaps/route.ts`

- [ ] **Step 1: Write the route**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { CreateRoadmapBodySchema } from '@/lib/roadmap-schema'

async function requireAdmin() {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return { ok: false as const, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  if (!(session as any).isAdmin) {
    return { ok: false as const, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  return { ok: true as const, session }
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response

  const projectIdStr = request.nextUrl.searchParams.get('projectId')
  const projectId = projectIdStr ? parseInt(projectIdStr, 10) : NaN
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return NextResponse.json({ error: 'projectId required (positive integer)' }, { status: 400 })
  }

  const mcm = request.nextUrl.searchParams.get('mcm')?.trim() || undefined

  const rows = await prisma.roadmap.findMany({
    where: { projectId, ...(mcm ? { mcm } : {}) },
    orderBy: [{ mcm: 'asc' }, { updatedAt: 'desc' }],
    select: {
      id: true, projectId: true, mcm: true, name: true, description: true,
      isPublished: true, createdAt: true, updatedAt: true, createdBy: true,
    },
  })

  // Step count derived from stepsJson length; cheap because Prisma doesn't
  // pull stepsJson here. We need a second pass to get just the lengths.
  const counts = await prisma.$queryRaw<{ id: number; step_count: number }[]>`
    SELECT id, COALESCE(jsonb_array_length(steps_json::jsonb), 0)::int AS step_count
    FROM roadmaps WHERE project_id = ${projectId}
  `
  const countMap = new Map(counts.map(c => [c.id, c.step_count]))

  return NextResponse.json({
    success: true,
    roadmaps: rows.map(r => ({
      ...r,
      stepCount: countMap.get(r.id) ?? 0,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  })
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = CreateRoadmapBodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', details: parsed.error.format() }, { status: 400 })
  }
  const { projectId, mcm, name } = parsed.data

  const project = await prisma.project.findUnique({ where: { id: projectId } })
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const createdBy = auth.session?.user?.email ?? auth.session?.user?.name ?? null

  const roadmap = await prisma.roadmap.create({
    data: {
      projectId, mcm: mcm.trim(), name: name.trim(),
      stepsJson: [],
      createdBy,
    },
  })
  return NextResponse.json({ success: true, roadmap: { ...roadmap, createdAt: roadmap.createdAt.toISOString(), updatedAt: roadmap.updatedAt.toISOString() } })
}
```

- [ ] **Step 2: Smoke-test**

Manually create via curl using an admin session cookie (or just visit the URL in the browser while logged in as admin). Quick header check:

```bash
curl -s -i "http://localhost:3003/api/admin/roadmaps?projectId=1" -o -
```

Expected: HTTP 401 if not logged in (the cookie check happens server-side and rejects unauth).

- [ ] **Step 3: Commit**

```bash
git add app/api/admin/roadmaps/route.ts
git commit -m "feat(roadmap): admin list + create /api/admin/roadmaps

List returns lightweight rows (no stepsJson body) with stepCount via a raw
jsonb_array_length pass. Create accepts {projectId, mcm, name} only;
stepsJson defaults to []; not published until PATCH.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: [CLOUD] Admin per-roadmap CRUD `/api/admin/roadmaps/[id]`

**Files:**
- Create: `app/api/admin/roadmaps/[id]/route.ts`

- [ ] **Step 1: Write the route**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { UpdateRoadmapBodySchema } from '@/lib/roadmap-schema'

async function requireAdmin() {
  const session = await getServerSession(authOptions)
  if (!session?.user) return { ok: false as const, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  if (!(session as any).isAdmin) return { ok: false as const, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  return { ok: true as const, session }
}

function parseId(idStr: string) {
  const id = parseInt(idStr, 10)
  return Number.isInteger(id) && id > 0 ? id : null
}

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response
  const id = parseId(params.id)
  if (!id) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const roadmap = await prisma.roadmap.findUnique({ where: { id } })
  if (!roadmap) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({
    success: true,
    roadmap: {
      ...roadmap,
      createdAt: roadmap.createdAt.toISOString(),
      updatedAt: roadmap.updatedAt.toISOString(),
    },
  })
}

export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response
  const id = parseId(params.id)
  if (!id) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = UpdateRoadmapBodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', details: parsed.error.format() }, { status: 400 })
  }
  const { name, description, steps, path } = parsed.data

  const existing = await prisma.roadmap.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const updated = await prisma.roadmap.update({
    where: { id },
    data: {
      name: name.trim(),
      description: description ?? null,
      stepsJson: steps,
      pathJson: path ?? null,
    },
  })
  return NextResponse.json({
    success: true,
    roadmap: { ...updated, createdAt: updated.createdAt.toISOString(), updatedAt: updated.updatedAt.toISOString() },
  })
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response
  const id = parseId(params.id)
  if (!id) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const existing = await prisma.roadmap.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await prisma.roadmap.delete({ where: { id } })
  return NextResponse.json({ success: true })
}
```

- [ ] **Step 2: Commit**

```bash
git add app/api/admin/roadmaps/[id]/route.ts
git commit -m "feat(roadmap): admin GET/PUT/DELETE /api/admin/roadmaps/:id

PUT replaces stepsJson + pathJson + name + description atomically.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: [CLOUD] Admin publish toggle `/api/admin/roadmaps/[id]/publish`

**Files:**
- Create: `app/api/admin/roadmaps/[id]/publish/route.ts`

- [ ] **Step 1: Write the route**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { PublishRoadmapBodySchema } from '@/lib/roadmap-schema'

async function requireAdmin() {
  const session = await getServerSession(authOptions)
  if (!session?.user) return { ok: false as const, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  if (!(session as any).isAdmin) return { ok: false as const, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  return { ok: true as const, session }
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response
  const id = parseInt(params.id, 10)
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = PublishRoadmapBodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', details: parsed.error.format() }, { status: 400 })
  }

  const existing = await prisma.roadmap.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const updated = await prisma.roadmap.update({
    where: { id },
    data: { isPublished: parsed.data.isPublished },
  })
  return NextResponse.json({ success: true, isPublished: updated.isPublished })
}
```

- [ ] **Step 2: Commit**

```bash
git add app/api/admin/roadmaps/[id]/publish/route.ts
git commit -m "feat(roadmap): PATCH /api/admin/roadmaps/:id/publish

Toggle isPublished. Only published roadmaps sync to field tool.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: [CLOUD] Helper: SVG by MCM `/api/admin/diagrams/by-mcm`

**Files:**
- Create: `app/api/admin/diagrams/by-mcm/route.ts`

- [ ] **Step 1: Write the route**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(session as any).isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const projectId = parseInt(request.nextUrl.searchParams.get('projectId') ?? '', 10)
  const mcm = request.nextUrl.searchParams.get('mcm')?.trim() ?? ''
  if (!Number.isInteger(projectId) || projectId <= 0) return NextResponse.json({ error: 'projectId required' }, { status: 400 })
  if (!mcm) return NextResponse.json({ error: 'mcm required' }, { status: 400 })

  const diagram = await prisma.mcmDiagram.findUnique({ where: { projectId_mcm: { projectId, mcm } } })
  if (!diagram) return NextResponse.json({ error: 'No diagram for that MCM' }, { status: 404 })

  return new NextResponse(diagram.svgContent, {
    status: 200,
    headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' },
  })
}
```

- [ ] **Step 2: Commit**

```bash
git add app/api/admin/diagrams/by-mcm/route.ts
git commit -m "feat(roadmap): GET /api/admin/diagrams/by-mcm helper

Returns the SVG body directly so the editor canvas can render it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: [CLOUD] Helper: devices on an MCM `/api/admin/devices`

**Files:**
- Create: `app/api/admin/devices/route.ts`

This route returns devices on an MCM by joining through `Subsystem` → `Io`. When `device=` is provided, returns just that one device's IOs (for the per-step IO dropdown).

Field-name note: the cloud Prisma model for IOs uses `networkDeviceName` (camelCase, mapped to a snake-case Postgres column). If that exact field is absent on `Io`, fall back to `Io.tag` or the closest naming for the device association — verify by inspecting `prisma/schema.prisma` and adapt the `select`/`groupBy` accordingly. The route shape stays the same.

- [ ] **Step 1: Confirm the device-name column**

```bash
grep -n "model Io " -A 40 prisma/schema.prisma | head -60
```

Note the column you'll use (most likely `networkDeviceName`). The rest of this task assumes that name; substitute if different.

- [ ] **Step 2: Write the route**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(session as any).isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const projectId = parseInt(request.nextUrl.searchParams.get('projectId') ?? '', 10)
  const mcm = request.nextUrl.searchParams.get('mcm')?.trim() ?? ''
  const device = request.nextUrl.searchParams.get('device')?.trim()
  if (!Number.isInteger(projectId) || projectId <= 0) return NextResponse.json({ error: 'projectId required' }, { status: 400 })
  if (!mcm) return NextResponse.json({ error: 'mcm required' }, { status: 400 })

  // Resolve subsystem(s) on this MCM
  const subsystems = await prisma.subsystem.findMany({
    where: { projectId, name: mcm },
    select: { id: true },
  })
  const subsystemIds = subsystems.map(s => s.id)
  if (subsystemIds.length === 0) {
    return NextResponse.json({ success: true, devices: [], ios: [] })
  }

  if (device) {
    const ios = await prisma.io.findMany({
      where: { subsystemId: { in: subsystemIds }, networkDeviceName: device },
      select: { id: true, name: true, description: true },
      orderBy: { id: 'asc' },
    })
    return NextResponse.json({ success: true, device, ios })
  }

  const grouped = await prisma.io.groupBy({
    by: ['networkDeviceName'],
    where: {
      subsystemId: { in: subsystemIds },
      networkDeviceName: { not: null },
    },
    _count: { _all: true },
    orderBy: { networkDeviceName: 'asc' },
  })
  return NextResponse.json({
    success: true,
    devices: grouped
      .filter(g => !!g.networkDeviceName)
      .map(g => ({ deviceName: g.networkDeviceName as string, ioCount: g._count._all })),
  })
}
```

- [ ] **Step 3: Smoke-test**

```bash
curl -s "http://localhost:3003/api/admin/devices?projectId=1&mcm=MCM09"
```

Expected: `{ success: true, devices: [...] }` listing one entry per `networkDeviceName` with an `ioCount`. Add `&device=UL17_20_VFD` to switch to the IO list.

- [ ] **Step 4: Commit**

```bash
git add app/api/admin/devices/route.ts
git commit -m "feat(roadmap): GET /api/admin/devices helper

Lists devices on an MCM (grouped Io rows) and per-device IO list when
device= is set. Drives the editor's IO dropdown.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — Cloud authoring UI

### Task 9: [CLOUD] List page `/admin/roadmaps`

**Files:**
- Create: `app/admin/roadmaps/page.tsx`

- [ ] **Step 1: Write the page**

```tsx
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { LayoutDashboard, Route as RouteIcon } from 'lucide-react'
import { ThemeToggle } from '@/components/theme-toggle'
import { UserMenu } from '@/components/user-menu'
import { prisma } from '@/lib/prisma'
import { CreateRoadmapDialog } from '@/components/create-roadmap-dialog'

export const dynamic = 'force-dynamic'

export default async function AdminRoadmapsPage() {
  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/')
  if (!(session as any).isAdmin) redirect('/')

  const projects = await prisma.project.findMany({
    where: { archived: false },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })

  const roadmaps = await prisma.roadmap.findMany({
    orderBy: [{ projectId: 'asc' }, { mcm: 'asc' }, { updatedAt: 'desc' }],
    select: {
      id: true, projectId: true, mcm: true, name: true,
      isPublished: true, updatedAt: true, createdBy: true,
    },
  })

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card sticky top-0 z-50">
        <div className="container mx-auto px-4 py-3 sm:py-4 flex items-center justify-between gap-3">
          <Link href="/" className="flex items-center gap-3 hover:opacity-80">
            <LayoutDashboard className="h-6 w-6 text-primary" />
            <div>
              <h1 className="text-xl sm:text-2xl font-bold flex items-center gap-2">
                <RouteIcon className="h-5 w-5" /> Roadmaps
              </h1>
              <p className="text-xs text-muted-foreground">Scripted walkdown routes for guided commissioning</p>
            </div>
          </Link>
          <div className="flex items-center gap-2">
            <a href="/admin" className="text-sm text-muted-foreground hover:text-foreground">← Back to Admin</a>
            <UserMenu />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        <CreateRoadmapDialog projects={projects} />

        {roadmaps.length === 0 ? (
          <div className="border rounded-lg p-10 text-center text-muted-foreground">
            No roadmaps yet. Use "New roadmap" above to create one.
          </div>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-3 py-2">Project</th>
                  <th className="text-left px-3 py-2">MCM</th>
                  <th className="text-left px-3 py-2">Name</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-left px-3 py-2">Updated</th>
                  <th className="text-left px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {roadmaps.map(r => {
                  const proj = projects.find(p => p.id === r.projectId)
                  return (
                    <tr key={r.id} className="border-t">
                      <td className="px-3 py-2">{proj?.name ?? `#${r.projectId}`}</td>
                      <td className="px-3 py-2 font-mono">{r.mcm}</td>
                      <td className="px-3 py-2">{r.name}</td>
                      <td className="px-3 py-2">
                        {r.isPublished
                          ? <span className="inline-block px-2 py-0.5 rounded bg-green-100 text-green-800 text-xs">Published</span>
                          : <span className="inline-block px-2 py-0.5 rounded bg-zinc-100 text-zinc-800 text-xs">Draft</span>}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{r.updatedAt.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right">
                        <Link className="text-primary hover:underline" href={`/admin/roadmaps/${r.id}`}>Edit →</Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  )
}
```

- [ ] **Step 2: Create the dialog component**

Create `components/create-roadmap-dialog.tsx`:

```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface Project { id: number; name: string }

export function CreateRoadmapDialog({ projects }: { projects: Project[] }) {
  const [open, setOpen] = useState(false)
  const [projectId, setProjectId] = useState<number | ''>(projects[0]?.id ?? '')
  const [mcm, setMcm] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  async function submit() {
    if (!projectId || !mcm.trim() || !name.trim()) return
    setBusy(true); setError(null)
    try {
      const r = await fetch('/api/admin/roadmaps', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, mcm: mcm.trim(), name: name.trim() }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`)
      router.push(`/admin/roadmaps/${data.roadmap.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button><Plus className="h-4 w-4 mr-1" /> New roadmap</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Create a roadmap</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Project</Label>
            <select className="w-full border rounded px-2 py-1.5 text-sm bg-background"
                    value={projectId} onChange={e => setProjectId(parseInt(e.target.value, 10) || '')}>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div><Label>MCM</Label>
            <Input value={mcm} onChange={e => setMcm(e.target.value)} placeholder="MCM09" />
          </div>
          <div><Label>Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="EPC walkdown" />
          </div>
          {error && <div className="text-xs text-red-600">{error}</div>}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy || !projectId || !mcm.trim() || !name.trim()}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add app/admin/roadmaps/page.tsx components/create-roadmap-dialog.tsx
git commit -m "feat(roadmap): /admin/roadmaps list page + create dialog

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: [CLOUD] Editor page shell `/admin/roadmaps/[id]`

**Files:**
- Create: `app/admin/roadmaps/[id]/page.tsx`
- Create: `components/roadmap-editor.tsx`

- [ ] **Step 1: Write the page shell**

`app/admin/roadmaps/[id]/page.tsx`:

```tsx
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { notFound, redirect } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { RoadmapEditor } from '@/components/roadmap-editor'

export const dynamic = 'force-dynamic'

export default async function RoadmapEditorPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/')
  if (!(session as any).isAdmin) redirect('/')

  const id = parseInt(params.id, 10)
  if (!Number.isInteger(id) || id <= 0) notFound()

  const roadmap = await prisma.roadmap.findUnique({ where: { id } })
  if (!roadmap) notFound()

  return (
    <RoadmapEditor
      roadmapId={roadmap.id}
      projectId={roadmap.projectId}
      mcm={roadmap.mcm}
      initialName={roadmap.name}
      initialDescription={roadmap.description}
      initialSteps={Array.isArray(roadmap.stepsJson) ? (roadmap.stepsJson as any[]) : []}
      initialPath={roadmap.pathJson as any}
      isPublished={roadmap.isPublished}
      updatedAt={roadmap.updatedAt.toISOString()}
    />
  )
}
```

- [ ] **Step 2: Write the editor stub**

`components/roadmap-editor.tsx`:

```tsx
'use client'
import { useEffect, useState } from 'react'
import { ArrowLeft, Save, Eye, EyeOff } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RoadmapSvgCanvas } from './roadmap-svg-canvas'
import { RoadmapStepList } from './roadmap-step-list'
import { RoadmapModeToolbar, type EditorMode } from './roadmap-mode-toolbar'

interface Step {
  order: number
  kind: 'device' | 'io'
  deviceName: string
  ioName?: string
  instructionText: string
  transitText?: string
}
interface Path { segments: Array<{ fromStep?: number; toStep?: number; points: Array<{ x: number; y: number }>; style?: 'arrow' | 'dashed' }> }

interface Props {
  roadmapId: number
  projectId: number
  mcm: string
  initialName: string
  initialDescription: string | null
  initialSteps: Step[]
  initialPath: Path | null
  isPublished: boolean
  updatedAt: string
}

export function RoadmapEditor(props: Props) {
  const [name, setName] = useState(props.initialName)
  const [steps, setSteps] = useState<Step[]>(props.initialSteps)
  const [path, setPath] = useState<Path | null>(props.initialPath)
  const [isPublished, setIsPublished] = useState(props.isPublished)
  const [mode, setMode] = useState<EditorMode>('add-steps')
  const [svg, setSvg] = useState<string | null>(null)
  const [svgError, setSvgError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selectedStep, setSelectedStep] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/admin/diagrams/by-mcm?projectId=${props.projectId}&mcm=${encodeURIComponent(props.mcm)}`)
      .then(async r => {
        if (!r.ok) throw new Error(`No diagram uploaded for ${props.mcm}`)
        return r.text()
      })
      .then(t => { if (!cancelled) setSvg(t) })
      .catch(e => { if (!cancelled) setSvgError(e.message) })
    return () => { cancelled = true }
  }, [props.projectId, props.mcm])

  function addStep(deviceName: string) {
    setSteps(prev => [
      ...prev,
      { order: prev.length + 1, kind: 'device', deviceName, instructionText: `Go to ${deviceName}` },
    ])
  }
  function updateStep(idx: number, patch: Partial<Step>) {
    setSteps(prev => prev.map((s, i) => i === idx ? { ...s, ...patch } : s))
  }
  function removeStep(idx: number) {
    setSteps(prev => prev.filter((_, i) => i !== idx).map((s, i) => ({ ...s, order: i + 1 })))
  }
  function moveStep(from: number, to: number) {
    setSteps(prev => {
      const next = prev.slice()
      const [s] = next.splice(from, 1)
      next.splice(to, 0, s)
      return next.map((x, i) => ({ ...x, order: i + 1 }))
    })
  }

  async function save() {
    setBusy(true)
    try {
      const r = await fetch(`/api/admin/roadmaps/${props.roadmapId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: null, steps, path }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`)
      alert('Saved')
    } catch (e) { alert(`Save failed: ${e instanceof Error ? e.message : e}`) }
    finally { setBusy(false) }
  }

  async function togglePublish() {
    setBusy(true)
    try {
      const r = await fetch(`/api/admin/roadmaps/${props.roadmapId}/publish`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPublished: !isPublished }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`)
      setIsPublished(data.isPublished)
    } catch (e) { alert(`Publish toggle failed: ${e instanceof Error ? e.message : e}`) }
    finally { setBusy(false) }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b bg-card px-3 py-2 flex items-center gap-3">
        <Link href="/admin/roadmaps" className="text-sm flex items-center gap-1 hover:underline">
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>
        <Input value={name} onChange={e => setName(e.target.value)} className="max-w-xs h-8 text-sm" />
        <span className="text-xs text-muted-foreground">MCM <span className="font-mono">{props.mcm}</span></span>
        <span className="flex-1" />
        <span className="text-xs text-muted-foreground">{steps.length} steps · {path?.segments.length ?? 0} path segments</span>
        <Button size="sm" variant="outline" onClick={save} disabled={busy}><Save className="h-4 w-4 mr-1" /> Save</Button>
        <Button size="sm" variant={isPublished ? 'secondary' : 'default'} onClick={togglePublish} disabled={busy}>
          {isPublished ? <><EyeOff className="h-4 w-4 mr-1" /> Unpublish</> : <><Eye className="h-4 w-4 mr-1" /> Publish</>}
        </Button>
      </header>

      <div className="flex-1 grid grid-cols-[1fr_360px] min-h-0">
        <div className="relative bg-slate-50 overflow-hidden">
          {svgError && <div className="p-6 text-sm text-red-600">{svgError}</div>}
          {!svgError && !svg && <div className="p-6 text-sm text-muted-foreground">Loading diagram…</div>}
          {svg && (
            <RoadmapSvgCanvas
              svgMarkup={svg}
              steps={steps}
              path={path}
              mode={mode}
              selectedStep={selectedStep}
              onDeviceClick={addStep}
              onSelectStep={setSelectedStep}
              onAppendPathSegment={(seg) => setPath(prev => ({ segments: [...(prev?.segments ?? []), seg] }))}
            />
          )}
          <RoadmapModeToolbar mode={mode} onChange={setMode} onClearPath={() => setPath(null)} />
        </div>
        <aside className="border-l bg-card overflow-y-auto">
          <RoadmapStepList
            projectId={props.projectId}
            mcm={props.mcm}
            steps={steps}
            selectedStep={selectedStep}
            onSelect={setSelectedStep}
            onUpdate={updateStep}
            onRemove={removeStep}
            onMove={moveStep}
          />
        </aside>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Commit (stub — the three subcomponents land in the next three tasks; the page won't compile until then, that's fine, no commit yet)**

Hold this commit until Tasks 11–13 land. Move directly to Task 11.

---

### Task 11: [CLOUD] `RoadmapSvgCanvas` (Add Steps mode)

**Files:**
- Create: `components/roadmap-svg-canvas.tsx`

- [ ] **Step 1: Write the component**

```tsx
'use client'
import { useEffect, useRef, useState } from 'react'
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch'
import type { EditorMode } from './roadmap-mode-toolbar'

interface Step {
  order: number; deviceName: string; kind: 'device' | 'io'
}
interface PathSegment {
  fromStep?: number; toStep?: number;
  points: Array<{ x: number; y: number }>;
  style?: 'arrow' | 'dashed'
}
interface Path { segments: PathSegment[] }

interface Props {
  svgMarkup: string
  steps: Step[]
  path: Path | null
  mode: EditorMode
  selectedStep: number | null
  onDeviceClick: (deviceName: string) => void
  onSelectStep: (idx: number | null) => void
  onAppendPathSegment: (seg: PathSegment) => void
}

export function RoadmapSvgCanvas({ svgMarkup, steps, path, mode, selectedStep, onDeviceClick, onSelectStep, onAppendPathSegment }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [draftPoints, setDraftPoints] = useState<Array<{ x: number; y: number }>>([])

  // Stamp data-step on every <g id> that's referenced by a step.
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    const orderByName = new Map(steps.map(s => [s.deviceName, s.order]))
    root.querySelectorAll<SVGGElement>('svg g[id]').forEach(g => {
      const id = g.getAttribute('id')
      if (!id) return
      const order = orderByName.get(id)
      if (order != null) g.setAttribute('data-step', String(order))
      else g.removeAttribute('data-step')
    })
  }, [svgMarkup, steps])

  // Click delegation: Add Steps mode appends; Draw Path mode adds a waypoint.
  useEffect(() => {
    const root = containerRef.current
    if (!root) return

    function svgPoint(evt: MouseEvent): { x: number; y: number } | null {
      const svg = root!.querySelector('svg') as SVGSVGElement | null
      if (!svg) return null
      const pt = svg.createSVGPoint()
      pt.x = evt.clientX; pt.y = evt.clientY
      const ctm = svg.getScreenCTM()
      if (!ctm) return null
      const local = pt.matrixTransform(ctm.inverse())
      return { x: local.x, y: local.y }
    }

    function handleClick(e: Event) {
      const me = e as MouseEvent
      const tgt = me.target as Element
      if (mode === 'add-steps') {
        const g = tgt.closest('g[id]') as SVGGElement | null
        if (!g) return
        const id = g.getAttribute('id')
        if (id) onDeviceClick(id)
      } else if (mode === 'draw-path') {
        const p = svgPoint(me)
        if (p) setDraftPoints(prev => [...prev, p])
      }
    }

    function handleDblClick(e: Event) {
      if (mode !== 'draw-path') return
      e.preventDefault()
      if (draftPoints.length >= 2) {
        onAppendPathSegment({ points: draftPoints, style: 'arrow' })
      }
      setDraftPoints([])
    }

    root.addEventListener('click', handleClick)
    root.addEventListener('dblclick', handleDblClick)
    return () => {
      root.removeEventListener('click', handleClick)
      root.removeEventListener('dblclick', handleDblClick)
    }
  }, [mode, draftPoints, onDeviceClick, onAppendPathSegment])

  return (
    <div className="absolute inset-0">
      <TransformWrapper minScale={0.2} maxScale={6} initialScale={0.7} centerOnInit
                        doubleClick={{ disabled: true }} wheel={{ step: 0.1 }}
                        panning={{ disabled: mode === 'draw-path' }}>
        <TransformComponent wrapperStyle={{ width: '100%', height: '100%' }} contentStyle={{ width: '100%', height: '100%' }}>
          <div ref={containerRef} className="roadmap-canvas" dangerouslySetInnerHTML={{ __html: svgMarkup }} />
        </TransformComponent>
      </TransformWrapper>
      <PathOverlayEditor steps={steps} path={path} selectedStep={selectedStep} draftPoints={draftPoints} containerRef={containerRef} />
      <style jsx global>{`
        .roadmap-canvas svg g[data-step] rect,
        .roadmap-canvas svg g[data-step] path { stroke: #2563eb; stroke-width: 2.5; fill: #bfdbfe; cursor: pointer; }
        .roadmap-canvas svg g[id]:not([data-step]) rect,
        .roadmap-canvas svg g[id]:not([data-step]) path { cursor: pointer; }
      `}</style>
    </div>
  )
}

/**
 * Renders an inline numbered badge per step + draws the path segments as
 * SVG arrows on top of the diagram. Implemented as an absolute-positioned
 * overlay so we don't rewrite the loaded SVG body.
 */
function PathOverlayEditor({ steps, path, selectedStep, draftPoints, containerRef }: {
  steps: Step[]; path: Path | null; selectedStep: number | null; draftPoints: Array<{x:number;y:number}>; containerRef: React.RefObject<HTMLDivElement>
}) {
  const [viewBox, setViewBox] = useState<string | null>(null)
  useEffect(() => {
    const svg = containerRef.current?.querySelector('svg') as SVGSVGElement | null
    if (!svg) return
    const vb = svg.getAttribute('viewBox')
    setViewBox(vb)
  }, [containerRef])
  if (!viewBox) return null
  const allSegs = path?.segments ?? []
  return (
    <svg className="absolute inset-0 pointer-events-none" viewBox={viewBox} preserveAspectRatio="xMidYMid meet" style={{ width: '100%', height: '100%' }}>
      <defs>
        <marker id="rm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill="#2563eb" />
        </marker>
      </defs>
      {allSegs.map((seg, i) => {
        const d = seg.points.map((p, j) => `${j === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
        return <path key={i} d={d} fill="none" stroke="#2563eb" strokeWidth="2.5"
                     strokeDasharray={seg.style === 'dashed' ? '6 4' : undefined}
                     markerEnd="url(#rm-arrow)" />
      })}
      {draftPoints.length > 0 && (
        <path d={draftPoints.map((p, j) => `${j === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')}
              fill="none" stroke="#9333ea" strokeWidth="2" strokeDasharray="3 3" />
      )}
    </svg>
  )
}
```

- [ ] **Step 2: Commit (Task 10 + 11 together since the editor wires them)**

Hold; commit after Task 13.

---

### Task 12: [CLOUD] `RoadmapStepList` right-side panel

**Files:**
- Create: `components/roadmap-step-list.tsx`

- [ ] **Step 1: Write the component**

```tsx
'use client'
import { useEffect, useState } from 'react'
import { Trash2, ArrowUp, ArrowDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface Step {
  order: number; kind: 'device' | 'io'; deviceName: string;
  ioName?: string; instructionText: string; transitText?: string
}

interface IoOption { id: number; name: string; description: string | null }

interface Props {
  projectId: number; mcm: string
  steps: Step[]
  selectedStep: number | null
  onSelect: (idx: number | null) => void
  onUpdate: (idx: number, patch: Partial<Step>) => void
  onRemove: (idx: number) => void
  onMove: (from: number, to: number) => void
}

export function RoadmapStepList({ projectId, mcm, steps, selectedStep, onSelect, onUpdate, onRemove, onMove }: Props) {
  return (
    <div className="p-3 space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Steps</h2>
      {steps.length === 0 && (
        <p className="text-xs text-muted-foreground">Click a device on the map to add the first step.</p>
      )}
      {steps.map((s, i) => (
        <StepRow
          key={i} idx={i} step={s}
          selected={selectedStep === i}
          projectId={projectId} mcm={mcm}
          onClick={() => onSelect(i)}
          onUpdate={(patch) => onUpdate(i, patch)}
          onRemove={() => onRemove(i)}
          onMoveUp={() => i > 0 && onMove(i, i - 1)}
          onMoveDown={() => i < steps.length - 1 && onMove(i, i + 1)}
        />
      ))}
    </div>
  )
}

function StepRow({ idx, step, selected, projectId, mcm, onClick, onUpdate, onRemove, onMoveUp, onMoveDown }: {
  idx: number; step: Step; selected: boolean; projectId: number; mcm: string
  onClick: () => void; onUpdate: (patch: Partial<Step>) => void; onRemove: () => void
  onMoveUp: () => void; onMoveDown: () => void
}) {
  const [ios, setIos] = useState<IoOption[] | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch(`/api/admin/devices?projectId=${projectId}&mcm=${encodeURIComponent(mcm)}&device=${encodeURIComponent(step.deviceName)}`)
      .then(r => r.json()).then(d => { if (!cancelled) setIos(d.ios ?? []) })
      .catch(() => { if (!cancelled) setIos([]) })
    return () => { cancelled = true }
  }, [projectId, mcm, step.deviceName])

  return (
    <div onClick={onClick}
         className={`border rounded p-3 space-y-2 text-sm cursor-pointer ${selected ? 'border-primary bg-primary/5' : ''}`}>
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-primary text-primary-foreground text-xs font-semibold">{step.order}</span>
        <span className="font-mono text-xs">{step.deviceName}</span>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); onMoveUp() }}><ArrowUp className="h-3 w-3" /></Button>
        <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); onMoveDown() }}><ArrowDown className="h-3 w-3" /></Button>
        <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); onRemove() }}><Trash2 className="h-3 w-3 text-red-600" /></Button>
      </div>
      <div>
        <Label className="text-xs">Instruction</Label>
        <textarea
          className="w-full text-sm border rounded px-2 py-1 mt-0.5 bg-background min-h-[60px]"
          value={step.instructionText} onClick={e => e.stopPropagation()}
          onChange={e => onUpdate({ instructionText: e.target.value })}
        />
      </div>
      <div>
        <Label className="text-xs">Specific IO (optional)</Label>
        <select className="w-full border rounded px-2 py-1 text-sm bg-background"
                value={step.ioName ?? ''} onClick={e => e.stopPropagation()}
                onChange={e => {
                  const v = e.target.value
                  onUpdate({ ioName: v || undefined, kind: v ? 'io' : 'device' })
                }}>
          <option value="">— Test entire device —</option>
          {(ios ?? []).map(io => <option key={io.id} value={io.name}>{io.name}{io.description ? ` · ${io.description}` : ''}</option>)}
        </select>
      </div>
      <div>
        <Label className="text-xs">Transit cue (optional)</Label>
        <Input className="h-8 text-sm" value={step.transitText ?? ''}
               onClick={e => e.stopPropagation()}
               onChange={e => onUpdate({ transitText: e.target.value || undefined })} />
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit-ready (see Task 13)**

---

### Task 13: [CLOUD] `RoadmapModeToolbar` + commit Phase 2 UI block

**Files:**
- Create: `components/roadmap-mode-toolbar.tsx`

- [ ] **Step 1: Write the component**

```tsx
'use client'
import { Pencil, MousePointer2, Eraser } from 'lucide-react'
import { Button } from '@/components/ui/button'

export type EditorMode = 'add-steps' | 'draw-path'

export function RoadmapModeToolbar({ mode, onChange, onClearPath }: {
  mode: EditorMode; onChange: (m: EditorMode) => void; onClearPath: () => void
}) {
  return (
    <div className="absolute left-3 bottom-3 flex items-center gap-1 bg-card border rounded shadow-sm p-1">
      <Button size="sm" variant={mode === 'add-steps' ? 'default' : 'ghost'} onClick={() => onChange('add-steps')}>
        <MousePointer2 className="h-4 w-4 mr-1" /> Add steps
      </Button>
      <Button size="sm" variant={mode === 'draw-path' ? 'default' : 'ghost'} onClick={() => onChange('draw-path')}>
        <Pencil className="h-4 w-4 mr-1" /> Draw path
      </Button>
      <Button size="sm" variant="ghost" onClick={onClearPath}>
        <Eraser className="h-4 w-4 mr-1" /> Clear path
      </Button>
    </div>
  )
}
```

- [ ] **Step 2: Run the dev server end-to-end smoke**

```bash
npm run dev
# open http://localhost:3003/admin/roadmaps in browser
# create roadmap → editor loads → click a device on SVG → step appears in right panel
# switch to Draw Path → click waypoints, double-click to end → arrow renders
# Save → Publish → toggle Unpublish
```

Fix any compile errors that surface. Expected: full editor renders and persists.

- [ ] **Step 3: Commit (Phase 2 UI bundled)**

```bash
git add app/admin/roadmaps/[id]/page.tsx \
        components/roadmap-editor.tsx \
        components/roadmap-svg-canvas.tsx \
        components/roadmap-step-list.tsx \
        components/roadmap-mode-toolbar.tsx
git commit -m "feat(roadmap): cloud authoring editor (canvas + step list + modes)

Click-on-SVG adds device-anchored steps; Draw Path mode lays polyline
waypoints; right panel edits instruction text, optional IO, transit cue,
reorders steps. Save persists via PUT /api/admin/roadmaps/:id.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 — Local foundation

### Task 14: [LOCAL] `Roadmaps` SQLite table bootstrap

**Files:**
- Modify: `lib/db-sqlite.ts`

- [ ] **Step 1: Locate the table bootstrap block**

```bash
grep -n "CREATE TABLE IF NOT EXISTS McmDiagrams" lib/db-sqlite.ts
```

- [ ] **Step 2: Append the table next to McmDiagrams**

In `lib/db-sqlite.ts`, after the `McmDiagrams` `CREATE TABLE IF NOT EXISTS` block (and its accompanying `CREATE INDEX` calls), add:

```ts
db.exec(`
  CREATE TABLE IF NOT EXISTS Roadmaps (
    Id           INTEGER PRIMARY KEY,
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
`)
```

- [ ] **Step 3: Restart dev and verify**

```bash
npm run dev
# wait for "Express server listening on :3010" or similar
# in a second terminal:
sqlite3 database.db ".schema Roadmaps"
```

Expected: prints the CREATE TABLE statement.

- [ ] **Step 4: Commit**

```bash
git add lib/db-sqlite.ts
git commit -m "feat(roadmap): add Roadmaps SQLite table bootstrap

Mirrors the cloud Roadmap row shape for offline cache.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: [LOCAL] Roadmap types + Zod schemas

**Files:**
- Create: `lib/guided/roadmap-types.ts`

- [ ] **Step 1: Write the file (mirror cloud schema)**

```ts
import { z } from 'zod'

export const RoadmapStepSchema = z.object({
  order: z.number().int().min(1),
  kind: z.enum(['device', 'io']),
  deviceName: z.string().min(1).max(120),
  ioName: z.string().min(1).max(120).optional(),
  instructionText: z.string().min(1).max(500),
  transitText: z.string().max(200).optional(),
}).refine(
  s => s.kind === 'device' || (s.kind === 'io' && !!s.ioName),
  { message: 'ioName is required when kind === "io"', path: ['ioName'] },
)

export type RoadmapStep = z.infer<typeof RoadmapStepSchema>

export const RoadmapPathSegmentSchema = z.object({
  fromStep: z.number().int().min(1).optional(),
  toStep: z.number().int().min(1).optional(),
  points: z.array(z.object({ x: z.number(), y: z.number() })).min(2),
  style: z.enum(['arrow', 'dashed']).optional(),
})

export const RoadmapPathSchema = z.object({
  segments: z.array(RoadmapPathSegmentSchema),
})

export type RoadmapPath = z.infer<typeof RoadmapPathSchema>

export const RoadmapSchema = z.object({
  id: z.number().int().positive(),
  projectId: z.number().int().positive(),
  mcm: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  stepsJson: z.array(RoadmapStepSchema),
  pathJson: RoadmapPathSchema.nullable().optional(),
  isPublished: z.boolean(),
  updatedAt: z.string().optional(),
})

export type Roadmap = z.infer<typeof RoadmapSchema>
```

- [ ] **Step 2: Verify zod is already a dep**

```bash
grep -E '"zod"' package.json
```

If missing: `npm install zod`. (Most likely already present — it's used elsewhere.)

- [ ] **Step 3: Commit**

```bash
git add lib/guided/roadmap-types.ts package.json package-lock.json
git commit -m "feat(roadmap): TS types + Zod schemas (mirrors cloud)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: [LOCAL] `roadmap-advance.ts` pure logic (TDD)

**Files:**
- Create: `__tests__/roadmap-advance.test.ts`
- Create: `lib/guided/roadmap-advance.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { shouldAdvanceStep } from '@/lib/guided/roadmap-advance'
import type { RoadmapStep } from '@/lib/guided/roadmap-types'

const deviceStep: RoadmapStep = {
  order: 1, kind: 'device', deviceName: 'UL17_20_VFD',
  instructionText: 'Test the VFD',
}
const ioStep: RoadmapStep = {
  order: 1, kind: 'io', deviceName: 'EPC1_2', ioName: 'EPC1_2.CORD_PULL',
  instructionText: 'Pull the cord',
}

describe('shouldAdvanceStep', () => {
  describe('device-kind', () => {
    it('does NOT advance when device is untested', () => {
      expect(shouldAdvanceStep(deviceStep, 'untested', null)).toBe(false)
    })
    it('does NOT advance when device is in_progress', () => {
      expect(shouldAdvanceStep(deviceStep, 'in_progress', null)).toBe(false)
    })
    it('advances when device is passed', () => {
      expect(shouldAdvanceStep(deviceStep, 'passed', null)).toBe(true)
    })
    it('advances when device is failed', () => {
      expect(shouldAdvanceStep(deviceStep, 'failed', null)).toBe(true)
    })
    it('does NOT advance when no_ios (treat as untestable, operator must skip)', () => {
      expect(shouldAdvanceStep(deviceStep, 'no_ios', null)).toBe(false)
    })
  })

  describe('io-kind', () => {
    it('does NOT advance when target IO has no result', () => {
      expect(shouldAdvanceStep(ioStep, 'in_progress', null)).toBe(false)
    })
    it('advances when target IO is passed', () => {
      expect(shouldAdvanceStep(ioStep, 'in_progress', 'Passed')).toBe(true)
    })
    it('advances when target IO is failed', () => {
      expect(shouldAdvanceStep(ioStep, 'in_progress', 'Failed')).toBe(true)
    })
    it('does NOT advance regardless of device state when IO is untested', () => {
      expect(shouldAdvanceStep(ioStep, 'passed', null)).toBe(false)
    })
  })
})
```

- [ ] **Step 2: Run test (should fail — module missing)**

```bash
npm run test -- roadmap-advance
```

Expected: FAIL "Cannot find module '@/lib/guided/roadmap-advance'".

- [ ] **Step 3: Implement**

```ts
import type { RoadmapStep } from './roadmap-types'

type DeviceState = 'untested' | 'in_progress' | 'passed' | 'failed' | 'skipped' | 'no_ios'
type IoResult = 'Passed' | 'Failed' | null

export function shouldAdvanceStep(
  step: RoadmapStep,
  deviceState: DeviceState,
  ioResult: IoResult,
): boolean {
  if (step.kind === 'io') {
    return ioResult === 'Passed' || ioResult === 'Failed'
  }
  return deviceState === 'passed' || deviceState === 'failed'
}
```

- [ ] **Step 4: Re-run test (should pass)**

```bash
npm run test -- roadmap-advance
```

Expected: all 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add __tests__/roadmap-advance.test.ts lib/guided/roadmap-advance.ts
git commit -m "feat(roadmap): shouldAdvanceStep pure logic + tests

io-kind advances on Pass/Fail of the target IO; device-kind advances on
passed/failed device state. no_ios is intentionally non-advancing —
operator must use Skip to move on.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: [LOCAL] `POST /api/cloud/pull-roadmap` route

**Files:**
- Create: `app/api/cloud/pull-roadmap/route.ts`
- Modify: `routes/index.ts`

- [ ] **Step 1: Write the route (mirror pull-mcm-diagram)**

```ts
import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'

const deleteStmt = db.prepare(`DELETE FROM Roadmaps WHERE Mcm = ?`)
const insertStmt = db.prepare(`
  INSERT INTO Roadmaps (Id, ProjectId, Mcm, Name, Description, StepsJson, PathJson, IsPublished, UpdatedAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

export async function POST(_req: Request, res: Response) {
  try {
    const config = await configService.getConfig()
    const remoteUrl = config.remoteUrl
    const apiPassword = config.apiPassword
    const subsystemId = typeof config.subsystemId === 'string'
      ? parseInt(config.subsystemId, 10) : config.subsystemId

    if (!remoteUrl) return res.status(400).json({ success: false, error: 'Cloud URL not configured' })
    if (!subsystemId) return res.status(400).json({ success: false, error: 'Subsystem ID not configured' })

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiPassword) headers['X-API-Key'] = apiPassword

    const url = `${remoteUrl}/api/sync/roadmaps?subsystemId=${subsystemId}`
    const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(20000) })
    if (!response.ok) {
      if (response.status === 404) return res.json({ success: true, mcm: null, count: 0, message: 'Subsystem not found on cloud' })
      return res.status(502).json({ success: false, error: `Cloud returned ${response.status}` })
    }

    const data = await response.json() as {
      success?: boolean; mcm?: string | null
      roadmaps?: Array<{ id: number; projectId: number; mcm: string; name: string; description: string | null;
        stepsJson: unknown; pathJson: unknown; isPublished: boolean; updatedAt: string }>
      message?: string
    }
    if (!data.mcm || !Array.isArray(data.roadmaps)) {
      return res.json({ success: true, mcm: data.mcm ?? null, count: 0, message: data.message || 'No roadmaps' })
    }

    const tx = db.transaction(() => {
      deleteStmt.run(data.mcm!)
      for (const r of data.roadmaps!) {
        insertStmt.run(
          r.id, r.projectId, r.mcm, r.name, r.description,
          JSON.stringify(r.stepsJson ?? []),
          r.pathJson ? JSON.stringify(r.pathJson) : null,
          r.isPublished ? 1 : 0, r.updatedAt,
        )
      }
    })
    tx()

    return res.json({ success: true, mcm: data.mcm, count: data.roadmaps.length })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[PullRoadmap] Error:', message)
    return res.status(500).json({ success: false, error: message })
  }
}
```

- [ ] **Step 2: Mount in `routes/index.ts`**

Find where `pull-mcm-diagram` is mounted (`grep -n "pull-mcm-diagram" routes/index.ts`). Add the matching import + mount line right after:

```ts
import * as pullRoadmap from '@/app/api/cloud/pull-roadmap/route'
// …
router.post('/api/cloud/pull-roadmap', asyncHandler(pullRoadmap.POST))
```

(Use the same `asyncHandler` wrapper the neighboring routes use; copy from the line directly above.)

- [ ] **Step 3: Smoke-test**

```bash
npm run dev
# in another terminal:
curl -s -X POST http://localhost:3010/api/cloud/pull-roadmap
```

Expected: with a real cloud at `remoteUrl` and a roadmap published, returns `{success:true, count: N}`. With no roadmap, returns `count: 0` and a friendly message.

```bash
sqlite3 database.db "SELECT Id, Mcm, Name, IsPublished FROM Roadmaps"
```

Expected: 0 or more rows.

- [ ] **Step 4: Commit**

```bash
git add app/api/cloud/pull-roadmap/route.ts routes/index.ts
git commit -m "feat(roadmap): /api/cloud/pull-roadmap mirrors diagram pull pattern

Deletes existing rows for the MCM then inserts the cloud's published set
in a single transaction.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: [LOCAL] `GET /api/roadmap` local cache read

**Files:**
- Create: `app/api/roadmap/route.ts`
- Modify: `routes/index.ts`

- [ ] **Step 1: Write the route**

```ts
import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

interface SubsystemRow { Name: string | null }
interface RoadmapRow {
  Id: number; ProjectId: number; Mcm: string; Name: string;
  Description: string | null; StepsJson: string; PathJson: string | null;
  IsPublished: number; UpdatedAt: string | null
}

export async function GET(req: Request, res: Response) {
  const subsystemIdRaw = req.query.subsystemId
  const subsystemId = typeof subsystemIdRaw === 'string' ? parseInt(subsystemIdRaw, 10) : NaN
  if (!subsystemId || isNaN(subsystemId) || subsystemId <= 0) {
    return res.status(400).json({ error: 'Valid subsystemId query param is required' })
  }

  const subsystem = db.prepare(`SELECT Name FROM Subsystems WHERE id = ?`).get(subsystemId) as SubsystemRow | undefined
  if (!subsystem?.Name) return res.json({ subsystemId, mcm: null, roadmaps: [] })

  const rows = db.prepare(`
    SELECT Id, ProjectId, Mcm, Name, Description, StepsJson, PathJson, IsPublished, UpdatedAt
      FROM Roadmaps WHERE Mcm = ? AND IsPublished = 1
      ORDER BY datetime(UpdatedAt) DESC
  `).all(subsystem.Name) as RoadmapRow[]

  return res.json({
    subsystemId, mcm: subsystem.Name,
    roadmaps: rows.map(r => ({
      id: r.Id, projectId: r.ProjectId, mcm: r.Mcm, name: r.Name, description: r.Description,
      stepsJson: JSON.parse(r.StepsJson || '[]'),
      pathJson: r.PathJson ? JSON.parse(r.PathJson) : null,
      isPublished: r.IsPublished === 1, updatedAt: r.UpdatedAt,
    })),
  })
}
```

- [ ] **Step 2: Mount**

In `routes/index.ts`:

```ts
import * as roadmapRoute from '@/app/api/roadmap/route'
// …
router.get('/api/roadmap', asyncHandler(roadmapRoute.GET))
```

- [ ] **Step 3: Smoke-test**

```bash
curl -s "http://localhost:3010/api/roadmap?subsystemId=15"
```

Expected: `{subsystemId:15, mcm:..., roadmaps:[...]}`.

- [ ] **Step 4: Commit**

```bash
git add app/api/roadmap/route.ts routes/index.ts
git commit -m "feat(roadmap): GET /api/roadmap for local cache read

Joins the subsystem's MCM name to the Roadmaps table, returns published
rows newest-first.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4 — Local playback UI

### Task 19: [LOCAL] `use-roadmap-session` reducer (TDD)

**Files:**
- Create: `__tests__/roadmap-session-reducer.test.ts`
- Create: `lib/guided/use-roadmap-session.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { roadmapReducer, initialRoadmapState, type RoadmapAction } from '@/lib/guided/use-roadmap-session'
import type { RoadmapStep } from '@/lib/guided/roadmap-types'

const steps: RoadmapStep[] = [
  { order: 1, kind: 'device', deviceName: 'A', instructionText: 'go to A' },
  { order: 2, kind: 'io', deviceName: 'B', ioName: 'B.IO1', instructionText: 'pull on B' },
  { order: 3, kind: 'device', deviceName: 'C', instructionText: 'finish at C' },
]

describe('roadmapReducer', () => {
  it('START loads steps and goes to currentStepIndex 0', () => {
    const next = roadmapReducer(initialRoadmapState, { type: 'START', roadmapId: 7, steps, path: null })
    expect(next.status).toBe('playing')
    expect(next.roadmapId).toBe(7)
    expect(next.steps).toHaveLength(3)
    expect(next.currentStepIndex).toBe(0)
    expect(next.stepResults).toEqual([
      { result: null }, { result: null }, { result: null },
    ])
  })

  it('ADVANCE moves index forward and records result', () => {
    const start = roadmapReducer(initialRoadmapState, { type: 'START', roadmapId: 1, steps, path: null })
    const next = roadmapReducer(start, { type: 'ADVANCE', result: 'passed' })
    expect(next.currentStepIndex).toBe(1)
    expect(next.stepResults[0]).toEqual({ result: 'passed' })
    expect(next.status).toBe('playing')
  })

  it('ADVANCE on the final step transitions to complete', () => {
    let state = roadmapReducer(initialRoadmapState, { type: 'START', roadmapId: 1, steps, path: null })
    state = roadmapReducer(state, { type: 'ADVANCE', result: 'passed' })
    state = roadmapReducer(state, { type: 'ADVANCE', result: 'passed' })
    state = roadmapReducer(state, { type: 'ADVANCE', result: 'failed' })
    expect(state.status).toBe('complete')
    expect(state.currentStepIndex).toBe(3) // === steps.length
  })

  it('SKIP_CURRENT records skipped and advances', () => {
    const start = roadmapReducer(initialRoadmapState, { type: 'START', roadmapId: 1, steps, path: null })
    const next = roadmapReducer(start, { type: 'SKIP_CURRENT' })
    expect(next.currentStepIndex).toBe(1)
    expect(next.stepResults[0]).toEqual({ result: 'skipped' })
  })

  it('END cancels and clears everything', () => {
    const start = roadmapReducer(initialRoadmapState, { type: 'START', roadmapId: 1, steps, path: null })
    const next = roadmapReducer(start, { type: 'END' })
    expect(next.status).toBe('cancelled')
    expect(next.steps).toEqual([])
    expect(next.currentStepIndex).toBe(0)
  })
})
```

- [ ] **Step 2: Run test (fails)**

```bash
npm run test -- roadmap-session-reducer
```

Expected: cannot find module.

- [ ] **Step 3: Implement**

```ts
import { useReducer, useCallback } from 'react'
import type { RoadmapStep, RoadmapPath } from './roadmap-types'

export interface RoadmapSessionState {
  status: 'idle' | 'playing' | 'complete' | 'cancelled'
  roadmapId: number | null
  steps: RoadmapStep[]
  path: RoadmapPath | null
  currentStepIndex: number
  stepResults: Array<{ result: 'passed' | 'failed' | 'skipped' | null }>
}

export const initialRoadmapState: RoadmapSessionState = {
  status: 'idle', roadmapId: null, steps: [], path: null,
  currentStepIndex: 0, stepResults: [],
}

export type RoadmapAction =
  | { type: 'START'; roadmapId: number; steps: RoadmapStep[]; path: RoadmapPath | null }
  | { type: 'ADVANCE'; result: 'passed' | 'failed' }
  | { type: 'SKIP_CURRENT' }
  | { type: 'END' }

export function roadmapReducer(state: RoadmapSessionState, action: RoadmapAction): RoadmapSessionState {
  switch (action.type) {
    case 'START':
      return {
        status: 'playing', roadmapId: action.roadmapId, steps: action.steps, path: action.path,
        currentStepIndex: 0,
        stepResults: action.steps.map(() => ({ result: null })),
      }
    case 'ADVANCE': {
      if (state.status !== 'playing') return state
      const nextResults = state.stepResults.slice()
      nextResults[state.currentStepIndex] = { result: action.result }
      const nextIdx = state.currentStepIndex + 1
      return {
        ...state,
        currentStepIndex: nextIdx,
        stepResults: nextResults,
        status: nextIdx >= state.steps.length ? 'complete' : 'playing',
      }
    }
    case 'SKIP_CURRENT': {
      if (state.status !== 'playing') return state
      const nextResults = state.stepResults.slice()
      nextResults[state.currentStepIndex] = { result: 'skipped' }
      const nextIdx = state.currentStepIndex + 1
      return {
        ...state,
        currentStepIndex: nextIdx,
        stepResults: nextResults,
        status: nextIdx >= state.steps.length ? 'complete' : 'playing',
      }
    }
    case 'END':
      return { ...initialRoadmapState, status: 'cancelled' }
    default:
      return state
  }
}

export function useRoadmapSession() {
  const [state, dispatch] = useReducer(roadmapReducer, initialRoadmapState)
  const start = useCallback((roadmapId: number, steps: RoadmapStep[], path: RoadmapPath | null) =>
    dispatch({ type: 'START', roadmapId, steps, path }), [])
  const advance = useCallback((result: 'passed' | 'failed') =>
    dispatch({ type: 'ADVANCE', result }), [])
  const skipCurrent = useCallback(() => dispatch({ type: 'SKIP_CURRENT' }), [])
  const end = useCallback(() => dispatch({ type: 'END' }), [])
  return { state, start, advance, skipCurrent, end }
}
```

- [ ] **Step 4: Re-run test (passes)**

```bash
npm run test -- roadmap-session-reducer
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add __tests__/roadmap-session-reducer.test.ts lib/guided/use-roadmap-session.ts
git commit -m "feat(roadmap): useRoadmapSession reducer + tests

START loads steps; ADVANCE/SKIP_CURRENT step forward and record results;
END cancels. Status becomes 'complete' once currentStepIndex === steps.length.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 20: [LOCAL] Zod-validation test for roadmap JSON

**Files:**
- Create: `__tests__/roadmap-types-validation.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from 'vitest'
import { RoadmapStepSchema, RoadmapSchema } from '@/lib/guided/roadmap-types'

describe('RoadmapStepSchema', () => {
  it('accepts a device-kind step without ioName', () => {
    const r = RoadmapStepSchema.safeParse({
      order: 1, kind: 'device', deviceName: 'A', instructionText: 'go'
    })
    expect(r.success).toBe(true)
  })
  it('accepts an io-kind step with ioName', () => {
    const r = RoadmapStepSchema.safeParse({
      order: 1, kind: 'io', deviceName: 'A', ioName: 'A.IO1', instructionText: 'pull'
    })
    expect(r.success).toBe(true)
  })
  it('rejects an io-kind step missing ioName', () => {
    const r = RoadmapStepSchema.safeParse({
      order: 1, kind: 'io', deviceName: 'A', instructionText: 'pull'
    })
    expect(r.success).toBe(false)
  })
  it('rejects order < 1', () => {
    const r = RoadmapStepSchema.safeParse({
      order: 0, kind: 'device', deviceName: 'A', instructionText: 'go'
    })
    expect(r.success).toBe(false)
  })
})

describe('RoadmapSchema', () => {
  it('parses a full roadmap row', () => {
    const r = RoadmapSchema.safeParse({
      id: 1, projectId: 1, mcm: 'MCM09', name: 'walk',
      stepsJson: [{ order: 1, kind: 'device', deviceName: 'A', instructionText: 'go' }],
      isPublished: true,
    })
    expect(r.success).toBe(true)
  })
  it('rejects when stepsJson contains invalid step', () => {
    const r = RoadmapSchema.safeParse({
      id: 1, projectId: 1, mcm: 'MCM09', name: 'walk',
      stepsJson: [{ order: 1, kind: 'io', deviceName: 'A', instructionText: 'go' }],
      isPublished: true,
    })
    expect(r.success).toBe(false)
  })
})
```

- [ ] **Step 2: Run and pass**

```bash
npm run test -- roadmap-types-validation
```

Expected: all tests pass (no implementation step — types from Task 15 already cover this).

- [ ] **Step 3: Commit**

```bash
git add __tests__/roadmap-types-validation.test.ts
git commit -m "test(roadmap): validate Zod schemas catch malformed steps

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 21: [LOCAL] `RoadmapPlaybackBanner` component

**Files:**
- Create: `components/guided/roadmap-playback-banner.tsx`

- [ ] **Step 1: Write the component**

```tsx
import type { RoadmapStep } from '@/lib/guided/roadmap-types'

interface Props {
  step: RoadmapStep | null
  currentIndex: number
  totalSteps: number
  isComplete: boolean
  passedCount: number
  failedCount: number
  skippedCount: number
  onPass: () => void
  onFail: () => void
  onSkip: () => void
  onEnd: () => void
}

export function RoadmapPlaybackBanner({ step, currentIndex, totalSteps, isComplete, passedCount, failedCount, skippedCount, onPass, onFail, onSkip, onEnd }: Props) {
  if (isComplete) {
    return (
      <div className="gm-roadmap-banner gm-roadmap-banner--complete">
        <div className="gm-roadmap-banner__title">Roadmap complete</div>
        <div className="gm-roadmap-banner__body">
          <strong>{passedCount}</strong> passed · <strong>{failedCount}</strong> failed · <strong>{skippedCount}</strong> skipped
        </div>
        <button className="gm-roadmap-banner__btn" onClick={onEnd}>Close</button>
      </div>
    )
  }
  if (!step) return null
  return (
    <div className="gm-roadmap-banner">
      <div className="gm-roadmap-banner__step">STEP {currentIndex + 1} OF {totalSteps}</div>
      <div className="gm-roadmap-banner__instr">▸ {step.instructionText}</div>
      {step.kind === 'io' && step.ioName && (
        <div className="gm-roadmap-banner__io">Targeting IO: <code>{step.ioName}</code></div>
      )}
      {step.transitText && (
        <div className="gm-roadmap-banner__transit">{step.transitText}</div>
      )}
      <div className="gm-roadmap-banner__buttons">
        <button className="gm-roadmap-banner__btn gm-roadmap-banner__btn--pass" onClick={onPass}>Pass</button>
        <button className="gm-roadmap-banner__btn gm-roadmap-banner__btn--fail" onClick={onFail}>Fail</button>
        <button className="gm-roadmap-banner__btn" onClick={onSkip}>Skip</button>
        <button className="gm-roadmap-banner__btn gm-roadmap-banner__btn--end" onClick={onEnd}>End</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit (bundle with overlay + picker once those land)**

Hold; commit at Task 23.

---

### Task 22: [LOCAL] `RoadmapPathOverlay` component

**Files:**
- Create: `components/guided/roadmap-path-overlay.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { useEffect, useState } from 'react'
import type { RoadmapPath } from '@/lib/guided/roadmap-types'

interface Props {
  path: RoadmapPath | null
  currentStepIndex: number
  containerRef: React.RefObject<HTMLElement>
}

/**
 * Renders the roadmap's drawn segments as SVG arrows on top of the diagram.
 * The active segment (toStep === currentStep) gets an animated dashed stroke;
 * earlier segments fade to faint gray; later segments are hidden.
 */
export function RoadmapPathOverlay({ path, currentStepIndex, containerRef }: Props) {
  const [viewBox, setViewBox] = useState<string | null>(null)
  useEffect(() => {
    const svg = containerRef.current?.querySelector('svg') as SVGSVGElement | null
    if (!svg) return
    setViewBox(svg.getAttribute('viewBox'))
  }, [containerRef])

  if (!viewBox || !path || path.segments.length === 0) return null

  return (
    <svg className="gm-roadmap-path-overlay" viewBox={viewBox} preserveAspectRatio="xMidYMid meet"
         style={{ position: 'absolute', inset: 0, pointerEvents: 'none', width: '100%', height: '100%' }}>
      <defs>
        <marker id="gm-arrow-active" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill="#2563eb" />
        </marker>
        <marker id="gm-arrow-faint" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8" />
        </marker>
      </defs>
      {path.segments.map((seg, i) => {
        // Active leg: anchored to current step index +1 (steps are 1-indexed)
        const isActive = seg.toStep === currentStepIndex + 1
        const isPast = seg.toStep != null && seg.toStep <= currentStepIndex
        const isFuture = seg.toStep != null && seg.toStep > currentStepIndex + 1
        if (isFuture) return null
        const d = seg.points.map((p, j) => `${j === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
        return (
          <path key={i} d={d} fill="none"
                stroke={isActive ? '#2563eb' : '#94a3b8'}
                strokeWidth={isActive ? 3 : 1.5}
                strokeDasharray={isActive ? '8 6' : undefined}
                markerEnd={`url(#gm-arrow-${isActive ? 'active' : 'faint'})`}
                style={{ opacity: isPast ? 0.55 : 1, animation: isActive ? 'gm-dash 1.2s linear infinite' : undefined }} />
        )
      })}
    </svg>
  )
}
```

- [ ] **Step 2: Commit (bundled with banner + picker — Task 23)**

---

### Task 23: [LOCAL] `RoadmapPicker` + commit Phase 4 components block

**Files:**
- Create: `components/guided/roadmap-picker.tsx`

- [ ] **Step 1: Write the component**

```tsx
import type { Roadmap } from '@/lib/guided/roadmap-types'

interface Props {
  roadmaps: Roadmap[]
  selectedRoadmapId: number | null
  onSelect: (id: number) => void
  onPull: () => void
  isPulling: boolean
}

export function RoadmapPicker({ roadmaps, selectedRoadmapId, onSelect, onPull, isPulling }: Props) {
  return (
    <div className="gm-roadmap-picker">
      <select value={selectedRoadmapId ?? ''} onChange={e => onSelect(parseInt(e.target.value, 10))}
              className="gm-roadmap-picker__select">
        <option value="" disabled>{roadmaps.length === 0 ? 'No roadmaps cached' : 'Pick a roadmap…'}</option>
        {roadmaps.map(r => <option key={r.id} value={r.id}>{r.name} ({r.stepsJson.length} steps)</option>)}
      </select>
      <button className="gm-roadmap-picker__pull" onClick={onPull} disabled={isPulling}>
        {isPulling ? 'Pulling…' : 'Pull from cloud'}
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Commit Phase 4 components**

```bash
git add components/guided/roadmap-playback-banner.tsx \
        components/guided/roadmap-path-overlay.tsx \
        components/guided/roadmap-picker.tsx
git commit -m "feat(roadmap): playback banner + path overlay + picker

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 24: [LOCAL] Lock-mode in `GuidedTestingMap`

**Files:**
- Modify: `components/guided/guided-testing-map.tsx`

- [ ] **Step 1: Find the props interface and effect that stamps `data-status`**

```bash
grep -n "data-status\|interface .* {" components/guided/guided-testing-map.tsx | head -20
```

- [ ] **Step 2: Add `lockedDevices` prop + stamping**

Find the `Props` interface (or whatever the component's props type is named) and add:

```ts
  /** When non-null and non-empty, every device id NOT in this set gets
   *  data-roadmap-locked="true" and is visually dimmed + click-disabled. */
  lockedDevices?: Set<string> | null
```

Find the existing `useEffect` that walks `svg g[id]` and stamps `data-status`. After that effect, add a sibling effect:

```ts
useEffect(() => {
  const root = containerRef.current
  if (!root) return
  const svgRoot = root.querySelector('svg')
  if (!svgRoot) return

  svgRoot.querySelectorAll<SVGGElement>('g[id]').forEach(g => {
    g.removeAttribute('data-roadmap-locked')
  })

  if (!lockedDevices || lockedDevices.size === 0) return

  svgRoot.querySelectorAll<SVGGElement>('g[id]').forEach(g => {
    const id = g.getAttribute('id')
    if (!id) return
    if (!lockedDevices.has(id)) {
      g.setAttribute('data-roadmap-locked', 'true')
    }
  })
}, [lockedDevices, svgMarkup])
```

Add `lockedDevices` to the destructured props on the component function: `function GuidedTestingMap({ svgMarkup, devices, activeDevice, onDeviceClick, lockedDevices }: Props, ref) { ... }`. (Match the exact signature shape used in the existing file — likely a `forwardRef`.)

- [ ] **Step 3: Commit**

```bash
git add components/guided/guided-testing-map.tsx
git commit -m "feat(roadmap): lockedDevices prop on GuidedTestingMap

Stamps data-roadmap-locked on every <g id> outside the allow-set so CSS
can dim + disable click on non-target devices during roadmap playback.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 25: [LOCAL] CSS rules for banner, locked, path

**Files:**
- Modify: `components/guided/guided-mode.css`

- [ ] **Step 1: Append new rules**

Append to the bottom of `components/guided/guided-mode.css`:

```css
/* ─── Roadmap lock mode ─── */
.guided-svg g[data-roadmap-locked="true"] {
  pointer-events: none;
}
.guided-svg g[data-roadmap-locked="true"] :where(rect, path) {
  opacity: 0.35;
  filter: grayscale(0.6);
}

/* ─── Roadmap playback banner ─── */
.gm-roadmap-banner {
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: 16px;
  background: linear-gradient(180deg, rgba(15,23,42,0.96) 0%, rgba(15,23,42,1) 100%);
  color: #f8fafc;
  border-radius: 10px;
  padding: 14px 18px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.35);
  z-index: 20;
}
.gm-roadmap-banner__step {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: #93c5fd;
}
.gm-roadmap-banner__instr {
  font-size: 18px;
  font-weight: 600;
  margin-top: 4px;
}
.gm-roadmap-banner__io {
  font-size: 12px;
  color: #cbd5e1;
  margin-top: 4px;
}
.gm-roadmap-banner__io code {
  background: rgba(255,255,255,0.08);
  padding: 1px 6px;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.gm-roadmap-banner__transit {
  font-size: 11px;
  color: #f59e0b;
  margin-top: 2px;
  font-style: italic;
}
.gm-roadmap-banner__buttons {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.gm-roadmap-banner__btn {
  padding: 8px 14px;
  border-radius: 6px;
  background: rgba(255,255,255,0.1);
  color: #f8fafc;
  border: 1px solid rgba(255,255,255,0.18);
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
}
.gm-roadmap-banner__btn--pass { background: #16a34a; border-color: #16a34a; }
.gm-roadmap-banner__btn--fail { background: #dc2626; border-color: #dc2626; }
.gm-roadmap-banner__btn--end  { background: transparent; }
.gm-roadmap-banner--complete .gm-roadmap-banner__instr { font-size: 22px; }

/* ─── Roadmap picker (inside FlowModeChip menu) ─── */
.gm-roadmap-picker {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 4px 6px;
}
.gm-roadmap-picker__select {
  flex: 1;
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 4px;
  border: 1px solid var(--gm-border, #e2e8f0);
  background: var(--gm-bg, white);
}
.gm-roadmap-picker__pull {
  font-size: 11px;
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid var(--gm-border, #e2e8f0);
  background: var(--gm-bg, white);
  cursor: pointer;
}
.gm-roadmap-picker__pull:disabled { opacity: 0.5; cursor: not-allowed; }

/* ─── Path overlay arrow animation ─── */
@keyframes gm-dash {
  to { stroke-dashoffset: -28; }
}
.gm-roadmap-path-overlay { pointer-events: none; }
```

- [ ] **Step 2: Commit**

```bash
git add components/guided/guided-mode.css
git commit -m "style(roadmap): banner, locked-device, path overlay rules

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 26: [LOCAL] Wire `FlowModeChip` + compose roadmap state in `GuidedModePage`

**Files:**
- Modify: `components/guided/guided-mode-page.tsx`

This is the biggest local-side change. Three things happen at once:
1. Add roadmap state (load cached list, hook `useRoadmapSession`).
2. Replace the stub `FlowModeChip` with one that includes a real "Roadmap" entry; show `<RoadmapPicker>` when active.
3. When roadmap session is `playing` or `complete`, render `<RoadmapPlaybackBanner>` + `<RoadmapPathOverlay>` and pass `lockedDevices` to the map.

- [ ] **Step 1: Add imports near the top**

```ts
import { RoadmapPlaybackBanner } from './roadmap-playback-banner'
import { RoadmapPathOverlay } from './roadmap-path-overlay'
import { RoadmapPicker } from './roadmap-picker'
import { useRoadmapSession } from '@/lib/guided/use-roadmap-session'
import { shouldAdvanceStep } from '@/lib/guided/roadmap-advance'
import type { Roadmap } from '@/lib/guided/roadmap-types'
```

- [ ] **Step 2: Inside `GuidedModePage()` near other hooks, add the roadmap state**

```tsx
const [roadmaps, setRoadmaps] = useState<Roadmap[]>([])
const [selectedRoadmapId, setSelectedRoadmapId] = useState<number | null>(null)
const [flowMode, setFlowMode] = useState<'scada' | 'roadmap'>('scada')
const [isPulling, setIsPulling] = useState(false)
const roadmap = useRoadmapSession()

// Load cached roadmaps for this subsystem
useEffect(() => {
  if (!subsystemId || isNaN(subsystemId)) return
  let cancelled = false
  fetch(`/api/roadmap?subsystemId=${subsystemId}`)
    .then(r => r.json())
    .then(d => { if (!cancelled) setRoadmaps(d.roadmaps ?? []) })
    .catch(err => { console.error('[Roadmap] load:', err); if (!cancelled) setRoadmaps([]) })
  return () => { cancelled = true }
}, [subsystemId])

async function pullRoadmaps() {
  setIsPulling(true)
  try {
    const r = await fetch('/api/cloud/pull-roadmap', { method: 'POST' })
    const _data = await r.json()
    const refreshed = await (await fetch(`/api/roadmap?subsystemId=${subsystemId}`)).json()
    setRoadmaps(refreshed.roadmaps ?? [])
  } catch (e) { console.error('[Roadmap] pull failed:', e) }
  finally { setIsPulling(false) }
}

function startSelectedRoadmap(id: number) {
  const r = roadmaps.find(x => x.id === id)
  if (!r) return
  setSelectedRoadmapId(id)
  roadmap.start(r.id, r.stepsJson, r.pathJson ?? null)
}

// Auto-advance check: whenever device/IO state changes, see if the current
// step's advance condition is now met.
const currentStep = roadmap.state.status === 'playing'
  ? roadmap.state.steps[roadmap.state.currentStepIndex] ?? null
  : null
useEffect(() => {
  if (!currentStep) return
  const dev = state.devices.find(d => d.deviceName === currentStep.deviceName)
  const deviceState = dev?.state ?? 'untested'
  let ioResult: 'Passed' | 'Failed' | null = null
  if (currentStep.kind === 'io' && currentStep.ioName) {
    // We need the IO's effective result. Cheap path: fetch the device's IOs
    // via the existing endpoint and look up the result. Since the device drawer
    // already does this fetch, in practice this is a small extra query.
    fetch(`/api/guided/devices/${encodeURIComponent(currentStep.deviceName)}?subsystemId=${subsystemId}`)
      .then(r => r.json())
      .then(d => {
        const io = (d.ios ?? []).find((x: any) => x.name === currentStep.ioName)
        ioResult = (io?.result as 'Passed' | 'Failed' | null) ?? null
        if (shouldAdvanceStep(currentStep, deviceState, ioResult)) {
          roadmap.advance(ioResult === 'Failed' || deviceState === 'failed' ? 'failed' : 'passed')
        }
      })
      .catch(() => {})
    return
  }
  if (shouldAdvanceStep(currentStep, deviceState, ioResult)) {
    roadmap.advance(deviceState === 'failed' ? 'failed' : 'passed')
  }
  // We re-run on every device list change; the dependency on
  // currentStep.deviceName + state.devices is enough.
}, [currentStep, state.devices, subsystemId])

// When roadmap is active, force-select the current step's device and pan to it
useEffect(() => {
  if (!currentStep) return
  openDevice(currentStep.deviceName)
  mapRef.current?.centerOnDevice(currentStep.deviceName)
}, [currentStep?.deviceName, openDevice])

// Locked-device set for the map
const lockedDevices = currentStep
  ? new Set<string>([currentStep.deviceName])
  : null
```

- [ ] **Step 3: Pass `lockedDevices` into `<GuidedTestingMap>`**

Find the existing `<GuidedTestingMap … />` JSX and add the prop:

```tsx
<GuidedTestingMap
  ref={mapRef}
  svgMarkup={svgMarkup}
  devices={state.devices}
  activeDevice={selectedDevice ?? currentTarget}
  onDeviceClick={openDevice}
  lockedDevices={lockedDevices}
/>
```

- [ ] **Step 4: Render the banner + overlay when roadmap is active**

Inside the main map container (right next to the existing legend / recenter overlays), add:

```tsx
{flowMode === 'roadmap' && (roadmap.state.status === 'playing' || roadmap.state.status === 'complete') && (
  <>
    <RoadmapPathOverlay
      path={roadmap.state.path}
      currentStepIndex={roadmap.state.currentStepIndex}
      containerRef={mapContainerRef}
    />
    <RoadmapPlaybackBanner
      step={currentStep}
      currentIndex={roadmap.state.currentStepIndex}
      totalSteps={roadmap.state.steps.length}
      isComplete={roadmap.state.status === 'complete'}
      passedCount={roadmap.state.stepResults.filter(r => r.result === 'passed').length}
      failedCount={roadmap.state.stepResults.filter(r => r.result === 'failed').length}
      skippedCount={roadmap.state.stepResults.filter(r => r.result === 'skipped').length}
      onPass={() => roadmap.advance('passed')}
      onFail={() => roadmap.advance('failed')}
      onSkip={() => roadmap.skipCurrent()}
      onEnd={() => { roadmap.end(); setFlowMode('scada'); setSelectedRoadmapId(null) }}
    />
  </>
)}
```

You'll need a `mapContainerRef` if there isn't one — add a `useRef<HTMLDivElement|null>(null)` near the other refs and wrap the map's container `<div className="gm-map-stage">` with it.

- [ ] **Step 5: Replace `FlowModeChip` body**

Find the `function FlowModeChip()` declaration in the same file. Replace its body with one that takes props and exposes the Roadmap option (lift state up — pass `flowMode`, `setFlowMode`, `roadmaps`, `selectedRoadmapId`, `onSelect`, `onPull`, `isPulling`):

```tsx
function FlowModeChip({ flowMode, setFlowMode, roadmaps, selectedRoadmapId, onSelectRoadmap, onPullRoadmaps, isPulling }: {
  flowMode: 'scada' | 'roadmap'
  setFlowMode: (m: 'scada' | 'roadmap') => void
  roadmaps: Roadmap[]
  selectedRoadmapId: number | null
  onSelectRoadmap: (id: number) => void
  onPullRoadmaps: () => void
  isPulling: boolean
}) {
  const [open, setOpen] = useState(false)
  const label = flowMode === 'roadmap' ? 'Roadmap' : 'SCADA order'
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen(o => !o)} className="gm-flow-chip" title="Ordering algorithm">
        <GitBranch size={11} />
        <span>Flow: {label}</span>
        <ChevronDown size={11} style={{ opacity: 0.6 }} />
      </button>
      {open && (
        <div className="gm-flow-menu" onMouseLeave={() => setOpen(false)}>
          <div className="gm-flow-item" data-active={flowMode === 'scada'} onClick={() => { setFlowMode('scada'); setOpen(false) }}>
            <span className="gm-flow-dot" /><span>SCADA document order</span>
          </div>
          <div className="gm-flow-item" data-active={flowMode === 'roadmap'} onClick={() => setFlowMode('roadmap')}>
            <span className="gm-flow-dot" /><span>Roadmap</span>
          </div>
          {flowMode === 'roadmap' && (
            <RoadmapPicker
              roadmaps={roadmaps}
              selectedRoadmapId={selectedRoadmapId}
              onSelect={onSelectRoadmap}
              onPull={onPullRoadmaps}
              isPulling={isPulling}
            />
          )}
        </div>
      )}
    </div>
  )
}
```

And update the JSX where `<FlowModeChip />` is rendered (in the header) to pass these props:

```tsx
<FlowModeChip
  flowMode={flowMode}
  setFlowMode={setFlowMode}
  roadmaps={roadmaps}
  selectedRoadmapId={selectedRoadmapId}
  onSelectRoadmap={startSelectedRoadmap}
  onPullRoadmaps={pullRoadmaps}
  isPulling={isPulling}
/>
```

- [ ] **Step 6: Type-check + lint**

```bash
npx tsc --noEmit
npm run lint
```

Expected: no new errors. If you see `Cannot find name 'subsystemId'` or similar, check the destructuring at the top of the page.

- [ ] **Step 7: Commit**

```bash
git add components/guided/guided-mode-page.tsx
git commit -m "feat(roadmap): wire FlowModeChip + roadmap playback into GuidedModePage

Adds Roadmap flow mode, RoadmapPicker dropdown, auto-advance via
shouldAdvanceStep when device/IO state changes, locked map (only the
current step's device is clickable), playback banner + path overlay.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 27: Manual end-to-end smoke test

**Files:** none changed — verification only.

- [ ] **Step 1: Bring both dev servers up**

Terminal A (cloud):
```bash
cd commissioning-cloud
npm run dev
# expect: server on http://localhost:3003
```

Terminal B (local field tool):
```bash
cd commissioning-local/frontend
npm run dev
# expect: server on http://localhost:3010, Vite on 5173/5174
```

Verify the local `config.json` `remoteUrl` points at `http://localhost:3003` and `apiPassword` matches a real `Project.apiKey` row in the cloud DB. If not, edit it (the field tool's settings page can do this) and restart the local server.

- [ ] **Step 2: Author a roadmap on cloud**

1. Browser → `http://localhost:3003/admin/roadmaps`
2. Sign in as an admin (Azure AD).
3. **New roadmap** → pick a project, MCM (must have an `McmDiagram` uploaded already; visit `/admin/diagrams` first if not), name e.g. "Demo walkdown".
4. In the editor: click 3+ devices on the SVG → 3+ steps appear.
5. For one step: pick a "Specific IO" from the dropdown → step turns into `kind: 'io'`. Edit the instruction text for at least two steps to be descriptive.
6. Switch to **Draw Path**, click waypoints between consecutive devices, double-click to finish. Draw at least 2 segments.
7. Click **Save**, then **Publish**.

- [ ] **Step 3: Play it back on local**

1. Browser → `http://localhost:5174/commissioning/<subsystemId>/guided` (use a subsystem whose `Name` matches the MCM you authored on).
2. Top-right `FlowModeChip` → switch to **Roadmap** → click **Pull from cloud** → the dropdown populates with "Demo walkdown".
3. Pick "Demo walkdown" → banner appears at the bottom, map pans to step 1, all non-step-1 devices dim.
4. In the right drawer (auto-opened for the step's device), click **Pass** on the current IO. Banner step number advances; map pans to step 2.
5. For the IO-grained step: only that IO's Pass advances; passing other IOs on the device does nothing.
6. Continue until the banner says "Roadmap complete · X passed · Y failed · Z skipped". Map shows the path traced.
7. Click **End** → returns to SCADA-order flow.

- [ ] **Step 4: Verify zero regressions**

1. Switch back to "SCADA document order" via FlowModeChip → existing behavior intact (auto-target, free clicks).
2. Visit `/commissioning/<subsystemId>` (manual grid) → unchanged.
3. Visit `/admin/diagrams` on cloud → unchanged.

- [ ] **Step 5: If everything checks out, commit the demo script for posterity**

```bash
mkdir -p docs
```

Create `docs/demo-roadmap-playthrough.md` with a copy of Steps 2–4 above as a tiny how-to.

```bash
git add docs/demo-roadmap-playthrough.md
git commit -m "docs(roadmap): demo playthrough script

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Done — what you have

- Cloud admin can author roadmaps on `/admin/roadmaps`, mixing device steps and IO steps, drawing a walking path, publishing.
- Local field tool pulls and plays roadmaps as a new flow mode in the existing Guided Mode page: scripted sequence, locked map, banner instructions, automatic advance on Pass/Fail.
- Both branches build cleanly, existing flows (SCADA order, manual grid, /admin/diagrams) untouched.
- Zero merge to main, zero production deploy — demo-only.

## Known cuts (documented in spec §9.3)

- Real PLC tag-trigger auto-advance.
- Persisting Pass/Fail to the DB via `/api/test`.
- Cross-MCM roadmaps.
- Roadmap draft snapshots / version history.
- `prisma migrate deploy` against production Postgres.
