# VFD Commissioning View — Design Spec

## Overview

Add a VFD commissioning view to the L2 page in the local tool. Technicians use it to run 5 sequential checks on VFD drives: verify identity, validate HP, bump motor, track belt, and setup speed. The view reads/writes PLC tags directly using device names from L2 data as tag base paths.

## Access

Tab toggle on the L2 page: "Validation" (existing spreadsheet) / "VFD Commissioning" (new view). Visible when the active L2 sheet has VFD devices.

## Data Source

VFD device list comes from L2 devices on the current sheet. Device names ARE the PLC tag base paths (e.g., `NCP1_7_VFD`). No new data import required.

## PLC Tag Interface

Per device, 14 tags derived from `{deviceName}.CTRL.CMD.*` and `{deviceName}.CTRL.STS.*`:

### Write (CMD)

| Field | Type | Check | Purpose |
|-------|------|-------|---------|
| Valid_Map | BOOL | 1 | Confirm VFD identity |
| Invalidate_Map | BOOL | 1 | Reset identity check |
| Valid_MTR_HP | BOOL | 2 | Confirm motor HP |
| Valid_APF_HP | BOOL | 2 | Confirm drive HP |
| Invalidate_HP | BOOL | 2 | Reset HP check |
| Valid_Direction | BOOL | 3 | Confirm motor direction |
| Bump | BOOL | 3 | Trigger 1s jog pulse (one-shot in PLC) |
| Invalidate_Direction | BOOL | 3 | Reset direction check |
| RPM | REAL | 4 | Tracking speed (0-30 range) |
| Track_Belt | BOOL | 4 | Start belt tracking |
| Stop_Belt_Tracking | BOOL | 4 | Stop belt tracking |
| Speed_FPM | INT | 5 | FPM value for speed setup |
| Sync_Speed | BOOL | 5 | Sync FPM to PLC |

### Read (STS)

| Field | Type | Purpose |
|-------|------|---------|
| Speed_FPM | INT | Current belt speed feedback |

## Storage

New SQLite table `VfdCheckState`:

```sql
CREATE TABLE IF NOT EXISTS VfdCheckState (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deviceName TEXT NOT NULL,
  subsystemId INTEGER,
  check1_status TEXT,      -- null | 'pass' | 'fail'
  check2_status TEXT,
  check3_status TEXT,
  check3_comment TEXT,     -- direction observation
  check4_status TEXT,
  check5_status TEXT,
  speed_fpm INTEGER,       -- stored FPM for check 5
  last_rpm REAL,           -- last RPM used for tracking
  updatedBy TEXT,
  updatedAt TEXT,
  UNIQUE(deviceName, subsystemId)
);
```

Local only. No cloud sync.

## UI Layout

Scrollable list of VFD devices, each as an expandable row:

**Collapsed:** Device name | MCM | Progress dots (5 checks) | Expand chevron

**Expanded — 5 sequential check sections:**

### Check 1: Verify Identity
- Prereq: PLC connected
- "Confirm Identity" button → writes `CMD.Valid_Map=1`
- "Reset" → writes `CMD.Invalidate_Map=1`
- Pass/Fail to record locally

### Check 2: Motor & Drive HP
- Prereq: Check 1 passed
- "Motor HP OK" → `CMD.Valid_MTR_HP=1`
- "Drive HP OK" → `CMD.Valid_APF_HP=1`
- "Reset" → `CMD.Invalidate_HP=1`
- Pass/Fail to record locally

### Check 3: Bump Motor
- Prereq: Check 2 passed
- "Bump" button → writes `CMD.Bump=1` (PLC one-shot: 1s jog pulse)
- Comment field for direction observation
- Pass → writes `CMD.Valid_Direction=1` + saves locally
- Fail → saves locally
- "Reset" → `CMD.Invalidate_Direction=1`

### Check 4: Track Belt
- Prereq: Check 3 passed
- RPM input (0-30) → writes `CMD.RPM`
- "Start" → `CMD.Track_Belt=1`
- "Stop" → `CMD.Stop_Belt_Tracking=1`
- Live display of `STS.Speed_FPM`
- Manual Pass/Fail

### Check 5: Setup Speed
- Prereq: Check 3 passed (independent of Check 4)
- FPM input field
- "Sync to PLC" → writes `CMD.Speed_FPM` then `CMD.Sync_Speed=1`
- Out-of-sync warning when local FPM != `STS.Speed_FPM`
- Manual Pass/Fail

## Offline Behavior

- VFD list and check states visible without PLC (from local DB)
- All PLC write buttons disabled when PLC not connected
- Gray overlay or disabled state with "PLC not connected" indicator

## API Endpoints

### POST /api/vfd-commissioning/write-tag
Write a single tag to PLC.
```json
Request:  { "deviceName": "NCP1_7_VFD", "field": "Bump", "value": 1, "dataType": "BOOL" }
Response: { "success": true, "tagPath": "NCP1_7_VFD.CTRL.CMD.Bump" }
```

### POST /api/vfd-commissioning/read-tags
Batch read CMD+STS tags for multiple devices.
```json
Request:  { "devices": ["NCP1_7_VFD", "NCP1_8_VFD"] }
Response: { "devices": { "NCP1_7_VFD": { "cmd": { "Valid_Map": 0, ... }, "sts": { "Speed_FPM": 0 } }, ... } }
```

### GET /api/vfd-commissioning/state?subsystemId=16
Get saved check states from local DB.

### POST /api/vfd-commissioning/state
Save check state for a device.
```json
Request:  { "deviceName": "NCP1_7_VFD", "subsystemId": 16, "check": 3, "status": "pass", "comment": "CW direction correct" }
```

## Not Included

- No cloud sync of VfdCheckState
- No auto-writing to L2 cells
- No AOI output reads
- No speed unit conversion
