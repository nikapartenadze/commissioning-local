# E-Stop Check Pass/Fail Recording

## Problem

The E-stop check view is currently observation-only. It reads PLC tags live and shows green/red status dots, but nothing is recorded. Technicians cannot prove they tested an EPC, and there's no audit trail. Field teams (e.g., TPA8) aren't using the tool for E-stop checks because there's no way to capture results.

## What Exists Today

- **E-stop structure** is defined in the database: Zones → EPCs → IO Points + VFDs
- **Live PLC tag reading** polls every 3 seconds and shows real-time status
- **Cloud sync** pushes live tag states every 5 seconds (for dashboard visibility)
- **No pass/fail columns** exist on any E-stop table
- **No test history** for E-stop checks
- **No UI controls** to record a test result

### Current Tables (no result tracking)

```
EStopZones    — id, SubsystemId, Name
EStopEpcs     — id, ZoneId, Name, CheckTag
EStopIoPoints — id, EpcId, Tag
EStopVfds     — id, EpcId, Tag, StoTag, MustStop
```

### Current UI

The `estop-check-view.tsx` component shows:
- Left panel: zone/EPC list with live status dots
- Right panel: selected EPC detail with IO points and VFD tags
- `EpcSummary` calculates OK/FAIL counts on-the-fly from PLC state — but never stores them

## What Needs to Happen

The EPC is the testable unit (analogous to an IO point in the IO checkout system). Each EPC needs pass/fail recording with the same data safety guarantees as IO testing.

### Testing Workflow

1. Technician selects an EPC or navigates to a zone
2. They physically **latch** (pull) the emergency pull cord
3. PLC reflects the latch: `checkTag` goes TRUE
4. The tool reads all associated tags:
   - `ioPoints[].value` — should all be TRUE (normally-closed contacts activated)
   - `mustStopVfds[].stoActive` — should all be TRUE (Safe Torque Off activated)
   - `keepRunningVfds[].stoActive` — should all be FALSE (these drives stay running)
5. **Auto-detection:** When `checkTag` transitions from FALSE → TRUE, the system snapshots all tag states at that moment
6. **Modal appears automatically:**
   - **All tags match expected values →** Modal shows green summary: "All checks passed. Record as Pass?" with Pass / Dismiss buttons
   - **Some tags don't match →** Modal shows failure summary with red items listed: "These checks failed: [list]. Record as Fail?" with Fail (+ required comment) / Dismiss buttons
7. Technician confirms → result is saved to local DB, queued for cloud sync
8. **Snapshot captures state at latch time** — if the cord is released while the modal is open, the recorded result still reflects the latched state. The technician doesn't need to hold the cord while confirming.

### What "Latched" Means

An E-stop EPC has a `checkTag` PLC tag. When the emergency pull cord is physically pulled (engaged), this tag reads TRUE. The system detects the FALSE → TRUE transition and treats that as the test event. The tag stays TRUE until the cord is manually reset (unlatched).

### Pass Criteria (all must be true simultaneously)

- `checkTag = TRUE` (the EPC is latched)
- Every `ioPoint.value = TRUE` (safety circuit contacts confirmed)
- Every `mustStopVfd.stoActive = TRUE` (drives that must stop have STO active)
- Every `keepRunningVfd.stoActive = FALSE` (drives that should keep running are still running)

### Fail Criteria

- `checkTag = TRUE` but any of the above conditions are not met
- The specific failing tags are captured and shown in the modal

## Schema Changes Needed

### Local (SQLite — `db-sqlite.ts`)

Add to `EStopEpcs` table:
```sql
Result TEXT,           -- 'Passed' | 'Failed' | null
TestedBy TEXT,         -- inspector name
Timestamp TEXT,        -- ISO timestamp of test
Comments TEXT,         -- failure reason / notes
Version INTEGER DEFAULT 0  -- for cloud sync
```

New table:
```sql
CREATE TABLE EStopTestHistories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  EpcId INTEGER NOT NULL REFERENCES EStopEpcs(id) ON DELETE CASCADE,
  Result TEXT NOT NULL,
  TestedBy TEXT,
  Timestamp TEXT NOT NULL,
  Comments TEXT,
  TagSnapshot TEXT,    -- JSON snapshot of all tag states at test time
  CreatedAt TEXT DEFAULT (datetime('now'))
);
```

New pending sync table (same pattern as IO PendingSyncs):
```sql
CREATE TABLE EStopPendingSyncs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  EpcId INTEGER NOT NULL,
  Result TEXT NOT NULL,
  TestedBy TEXT,
  Comments TEXT,
  TagSnapshot TEXT,
  Timestamp TEXT,
  CreatedAt TEXT DEFAULT (datetime('now')),
  RetryCount INTEGER DEFAULT 0,
  LastError TEXT,
  Version INTEGER DEFAULT 0
);
```

### Cloud (Prisma — `schema.prisma`)

Mirror the local changes:
- Add `result`, `testedBy`, `timestamp`, `comments`, `version` to the EPC model
- Add `EStopTestHistory` model
- Add sync endpoint to receive E-stop test results

## API Endpoints Needed

### Local (`frontend/app/api/`)

- `POST /api/estop/[epcId]/test` — Record pass/fail result for an EPC
  - Same pattern as `/api/ios/[id]/test`
  - Atomic: update EStopEpcs + insert EStopTestHistories + insert EStopPendingSyncs
  - Trigger instant sync push via `enqueueSyncPush()`

### Cloud (`commissioning-cloud/app/api/sync/`)

- `POST /api/sync/estop-results` — Receive E-stop test results from local tools
  - Same pattern as `/api/sync/update` (always accept, increment version)
  - Create TestHistory entry
  - Broadcast via SSE

## Sync Behavior

Identical to IO sync — local tool is the leader:

1. Result saved to local SQLite immediately
2. Entry created in `EStopPendingSyncs` queue
3. Instant push attempted via HTTP POST
4. Background sync drains queue every 30 seconds
5. Cloud always accepts (no version gating)
6. SSE broadcasts to other connected instances
7. Queue entry deleted only after cloud confirms

## UI Changes

### `estop-check-view.tsx`

- Track previous `checkTag` state per EPC to detect FALSE → TRUE transition
- On transition: snapshot all tag states, determine pass/fail, open modal
- Modal shows:
  - EPC name and zone
  - Tag state summary (green = match, red = mismatch)
  - Pass / Fail buttons (Fail requires comment)
  - Dismiss button (skip recording)
- After recording: show result badge on EPC card (same as IO grid badges)
- Add progress indicator: "X/Y EPCs tested" per zone

### Cloud dashboard

- Show E-stop test results on the project dashboard
- Same read-only display as IO results (badge per EPC)
- Add to progress/completion tracking

## Data Safety Guarantees

Same as IO system:

| What | How |
|------|-----|
| Test results | Saved to SQLite immediately on confirm |
| Tag snapshot | Captured at latch time, stored as JSON |
| Cloud sync | Instant push + 30s background retry |
| Sync queue | SQLite-persisted, survives crashes |
| Audit trail | EStopTestHistories, append-only, never deleted |
| Offline | Local testing continues, syncs when connected |
| Multi-user | Last write wins, both in audit history |
