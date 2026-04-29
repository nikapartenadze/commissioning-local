# Belt Tracking Mechanics Page — Plan

**Branch**: `belt-tracking-mechanics` (to be created from `main`)
**Owner**: Nika
**Driver**: Kevin Katze (mechanical foreman, asked 2026-04-28 in Slack)

---

## 1. Context

The local commissioning tool already records **Belt Tracked** state per VFD as
an L2 cell that syncs to cloud. Today, marking it requires the mechanic to
navigate the full FV spreadsheet — too much surface area for someone whose
only interaction with the tool is one column.

Kevin's ask: a focused page with three columns — VFD, Ready for Tracking,
Tracked — that mechanics can hit by URL on a tablet. They glance at "Ready",
do the physical work, tap "Tracked". Marks propagate to cloud automatically.

We do **not** want the mechanics to navigate the rest of the app, but we will
**not** build an auth/role system to enforce that. The whole tool is already
URL-open today; URL-secrecy + a focused page with no nav links is the
pragmatic answer.

---

## 2. Decisions

### 2.1 Reuse, don't rebuild
- **Read**: new endpoint that joins existing tables. Don't reuse `/api/l2`
  wholesale (returns all columns, too noisy).
- **Write**: reuse existing `POST /api/l2/cell` — same path the FV grid uses.
  This guarantees writes hit `L2PendingSyncs` and reach cloud the same way as
  every other L2 edit.
- **Sync status**: poll existing `GET /api/cloud/status` which already exposes
  `pendingL2SyncCount` and cloud connection state.

### 2.2 No new auth, no new roles
- URL `/belt-tracking` is unauthenticated.
- Page chrome has **no nav links** — no toolbar, no back-into-app buttons.
  A mechanic who types a different URL by hand can still get there; that's
  acceptable risk.
- Mechanic identity = `localStorage.mechanic-name`, prompted once on first
  visit, stamped as `updatedBy` on writes. Mirrors the existing
  `tester-name` pattern.

### 2.3 No subsystem id in URL
- The local server is configured with one active subsystem at a time
  (`config.json` → `subsystemId`). The page reads the active subsystem from
  config — same as how the main commissioning page does it. **One URL** to
  share, regardless of project.
- URL: `/belt-tracking` (no params).

### 2.4 "Ready for Tracking" derivation
- Already stored in `VfdControlsVerified` (local-only table, not cloud-synced).
  A row exists when a tech finished the wizard's Step 4.
- This gets joined into the page's read endpoint. Field-server-bound, which
  is fine: techs and mechanics are on the same field server.

### 2.5 UI direction: punch list (Direction A from brainstorm)
Three collapsing sections by state:
- **Ready for Tracking** (action items) — expanded by default
- **Tracked** (done) — collapsed, expand to undo
- **Not Ready** (waiting on tech) — collapsed, informational

Optimistic UI: tap → row jumps section, no spinner. Light theme, big tap
targets, mobile-first responsive.

### 2.6 What we DON'T build (out of scope)
- Login page / mechanic accounts / PINs
- Role-gated nav in the rest of the tool
- Service worker / true offline support beyond what L2PendingSyncs already
  provides
- A new sync mechanism — we use the existing one
- Any change to the cloud commissioning app (writes already propagate via the
  existing L2 sync contract)

---

## 3. Architecture

### 3.1 Data flow

```
Mechanic taps "Mark Tracked"
  ↓
POST /api/l2/cell  { deviceId, columnId: <Belt Tracked>, value: "Yes", updatedBy: <mechanic name> }
  ↓
L2CellValues row upserted (existing logic)
L2PendingSyncs row enqueued (existing logic)
  ↓ (auto-sync, every 30s)
POST cloud /api/sync/l2/update
  ↓
Cloud commissioning app's functional data updates
```

### 3.2 Read endpoint shape

`GET /api/belt-tracking` (no params; reads config for active subsystem)

```json
{
  "subsystemId": 45,
  "subsystemName": "MCM09",
  "beltTrackedColumnId": 12,
  "vfds": [
    {
      "deviceId": 5,
      "deviceName": "UL17_20_VFD",
      "mcm": "MCM09",
      "ready": true,
      "readyAt": "2026-04-28T14:22:00Z",
      "readyBy": "ASH",
      "tracked": false,
      "trackedAt": null,
      "trackedBy": null,
      "version": 3
    }
  ]
}
```

The endpoint joins:
- `L2Devices` filtered to the configured subsystem
- `L2CellValues` where `ColumnId = <Belt Tracked column id>`
- `VfdControlsVerified` by `deviceName`

`beltTrackedColumnId` is returned at the top level so the client knows which
column id to write to (no need to fetch the full L2 column list separately).

### 3.3 Status pill polling

Every 5 seconds:
- `GET /api/cloud/status` → `{ pendingL2SyncCount, dirtyQueues, ... }`

Pill states map to:
- 🟢 Online — `pendingL2SyncCount === 0` and SSE connected
- 🟡 Syncing N — `pendingL2SyncCount > 0` and connected
- 🟠 Offline — N pending — SSE disconnected, count > 0
- 🔴 Server unreachable — fetch itself fails N times in a row

---

## 4. File Plan

### New files

| File | Purpose |
|---|---|
| `frontend/app/belt-tracking/page.tsx` | Lazy-loaded route entry |
| `frontend/components/belt-tracking/belt-tracking-page.tsx` | Top-level layout, state |
| `frontend/components/belt-tracking/vfd-row.tsx` | Single VFD card with action button |
| `frontend/components/belt-tracking/section-header.tsx` | Collapsing section header with count |
| `frontend/components/belt-tracking/sync-status-pill.tsx` | Live online/offline/syncing indicator |
| `frontend/components/belt-tracking/mechanic-name-prompt.tsx` | One-time name capture modal |
| `frontend/components/belt-tracking/belt-tracking.css` | Scoped styles |
| `frontend/lib/belt-tracking/types.ts` | `VfdRow`, `VfdState`, `SyncPillState` |
| `frontend/lib/belt-tracking/use-belt-tracking.ts` | Hook: data fetch, optimistic write, status poll |
| `frontend/app/api/belt-tracking/route.ts` | `GET` handler |
| `frontend/__tests__/belt-tracking-api.test.ts` | API integration test |
| `frontend/__tests__/belt-tracking-state.test.ts` | Pure-function test for state derivation |

### Modified files

| File | Change |
|---|---|
| `frontend/src/router.tsx` | Register `/belt-tracking` route |
| `frontend/routes/index.ts` | Mount the new API route |
| `frontend/components/plc-toolbar.tsx` | Admin-only "Copy mechanics URL" button |

### Untouched (deliberately)
- Cloud commissioning app
- Auth middleware
- User schema
- FV view component (we're not changing it; reuse its write path only)
- L2 sync infra

---

## 5. Tasks

Approximately 1 day end-to-end. Numbered for subagent dispatch.

**Task 1 — Branch + types** (~15 min)
- Create branch `belt-tracking-mechanics` from main
- Define `lib/belt-tracking/types.ts`

**Task 2 — Read endpoint** (~1 hr, TDD)
- `app/api/belt-tracking/route.ts`
- Resolve active subsystem from config
- Resolve "Belt Tracked" columnId
- Join query (L2Devices + L2CellValues + VfdControlsVerified)
- Test with empty subsystem, mixed states, missing column edge cases

**Task 3 — Hook + state derivation** (~45 min, TDD)
- `lib/belt-tracking/use-belt-tracking.ts`
- Fetches the read endpoint, holds in-memory state
- Optimistic write: `markTracked(deviceId, value)` updates state immediately,
  fires `POST /api/l2/cell`, rolls back on failure
- Polls `/api/cloud/status` every 5s for sync state
- Test optimistic happy path + write-failure rollback

**Task 4 — Sync status pill** (~30 min)
- `components/belt-tracking/sync-status-pill.tsx`
- 4 visual states keyed off the hook's status output

**Task 5 — Mechanic name prompt** (~30 min)
- `components/belt-tracking/mechanic-name-prompt.tsx`
- Mounts when `localStorage.mechanic-name` is empty
- Required, single-input, "Continue" button
- Stored permanently; "Change name" link in page footer

**Task 6 — VFD row + section components** (~1 hr)
- `vfd-row.tsx` — name, ready badge, big "Mark Tracked" / "Untrack" button
- `section-header.tsx` — collapsible header with count
- Action button shows confirmation toast before commit (avoids fat-finger)

**Task 7 — Page assembly + styles** (~1.5 hr)
- `belt-tracking-page.tsx` — three sections, search input, header bar
- `belt-tracking.css` — light theme, big tap targets, factory-floor contrast
- Empty state when no VFDs ready/tracked
- Loading state for first fetch
- Hard error state when read endpoint fails (red banner)

**Task 8 — Routing + entry** (~30 min)
- Register route in `src/router.tsx`
- Mount API in `routes/index.ts`
- Add admin-only "Copy mechanics URL" button to `plc-toolbar.tsx`
  (Builds `${window.location.origin}/belt-tracking`, copies to clipboard,
  shows confirmation toast)

**Task 9 — Manual smoke test** (~30 min)
- Start dev server
- Open `/belt-tracking` on a phone or narrow window
- Verify: ready VFDs visible, tap → moves to Tracked, pending count shows,
  drains within 30s, disconnect cloud → orange pill, marks still save,
  reconnect → drains
- Verify cloud commissioning app reflects updates

---

## 6. Acceptance Criteria

1. Visit `/belt-tracking` — page loads, no toolbar, no app nav visible.
2. First visit prompts for mechanic name; subsequent visits skip the prompt.
3. Page shows three sections: Ready, Tracked, Not Ready, with counts in each
   section header.
4. Tapping "Mark Tracked" on a Ready row:
   - Optimistically moves the row to the Tracked section
   - Sync pill shows "Syncing 1" (or just bumps the count)
   - Within ~30s, pill returns to "All synced"
5. Cloud commissioning app reflects the marked state on its next refresh.
6. Disconnecting cloud (block egress to `commissioning.autstand.com`):
   - Pill goes orange "Offline — N pending"
   - Marks still save and the optimistic UI works
   - When cloud is reachable again, pending drains
7. No DB writes happen except the intended `L2CellValues` upsert.
8. All existing tests still pass.
9. Page works on a 360px-wide phone screen.

---

## 7. Risk Register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Mechanic types `/commissioning/45` and lands in the full app | Medium | Out of scope — we accept this. The chrome on the mechanics page has no breadcrumbs out, so they have to type by hand. |
| "Belt Tracked" column not present in this server's L2 schema | Low | Endpoint returns a clear error; page shows "Belt tracking column not configured for this subsystem." |
| Two mechanics mark the same VFD simultaneously | Low | Existing L2 versioning + last-write-wins handles it. |
| `VfdControlsVerified` rows missing because techs are on a different server | Medium | Document it: techs and mechanics need the same field server. |
| Mechanic name field abused (long strings, profanity) | Low | Cap input to 40 chars; out of scope to filter content. |

---

## 8. Open Questions (asked, awaiting answers)

1. **Untrack policy**: allow undo with confirmation? Default: yes.
2. **Mobile vs tablet**: are mechanics primarily on phones or tablets?
   Default: design for both, mobile-first breakpoints.
3. **Discoverability for techs**: should the regular commissioning page show
   "5 VFDs ready for belt tracking" anywhere as a hint to flag mechanics?
   Default: not in v1 — Kevin can flag mechanics manually.

---

## 9. Future work (Phase 2)

- Multi-subsystem mechanic view (if Kevin's team handles multiple
  subsystems on one server)
- Push notification or shared-screen update when a new VFD becomes Ready
- Real auth + a `mechanic` role, gating the mechanics URL and hiding the
  rest of the nav for that role
- Analytics: time-to-track distribution per mechanic / per device type
