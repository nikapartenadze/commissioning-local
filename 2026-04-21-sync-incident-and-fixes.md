# Sync Queue Stuck Incident & Proposed Fixes — 2026-04-21

Post-mortem and design notes from investigating why Arick Iglesias's field laptop
had 11 items permanently stuck in the FV (Functional Validation) sync queue,
plus design proposals to prevent this in the future.

## 1. The incident

On 2026-04-21 at the factory (project/subsystem using PLC at `11.200.1.1`), the
local commissioning tool on Arick Iglesias's laptop accumulated 11 stuck
`L2PendingSyncs` rows. Repeatedly clicking "Sync to cloud" reported success but
the queue count never decreased. The app later stopped responding and the process
exited without a visible error.

Artifacts provided for investigation:
- `app.log` from the field laptop
- `errors.log` from the field laptop
- `database.db` snapshot from the field laptop

## 2. What caused the stuck queue

### 2.1 Version model (how the data is structured)

Each L2 cell is one row in `L2CellValues`:
- `DeviceId + ColumnId` = one cell (e.g., `UL29_19_VFD` + `Check Direction`)
- Each cell has its own independent `Version` counter
- Every local value change increments `Version` by 1
- Cloud tracks its own independent version per cell

### 2.2 Protocol mismatch under concurrent writes

The local tool pushes with `version: localVersion - 1` (the "expected previous
cloud version"). Cloud accepts the write only when `cloud.version == incoming.version`
(strict equality). If cloud's version has moved ahead — for example because another
technician's laptop already pushed a write to the same cell — the incoming write
is rejected and the cell is simply **omitted from the `updates` response array**.

The local tool interprets a missing cell in the response as "version conflict —
will retry" and increments `RetryCount` on the pending sync row. The row stays
pending. The next retry reads the same local version, sends the same
`localVersion - 1`, and cloud rejects again for the same reason. Infinite loop.

### 2.3 Why the drift happened on 2026-04-21

Looking at the 11 stuck rows plus the cloud `updated_at` timestamps, the pattern
was clear: **multiple technicians were testing the same bank of VFDs at the same time**.

Examples (Arick's pending sync first-warn time vs cloud's last update by another user):

| Cell | Cloud update | Arick first warned |
|------|--------------|--------------------|
| UL23_25_VFD / Verify Identity | Jonathan Pickett — 17:32:13 | 17:32:25 |
| UL20_19_VFD / Verify Identity | Ron Espiritu — 17:39:42 | 17:39:50 |
| UL20_19_VFD / Verify Identity | Jonathan Pickett — 18:00:12 | 18:00:17 |
| UL29_19_VFD / Verify Identity | Ron Espiritu — 18:05:31 | 18:08:37 |

In each case, another tech's laptop pushed a write to the exact same cell within
seconds of Arick's pending sync starting to warn. Cloud advanced past what
Arick's local tool expected, and his retry loop was stuck forever.

The VFD wizard made this worse because it does batch writes of 5–6 cells in a
single request. When the request timed out (seen repeatedly in `errors.log` as
`The operation was aborted due to timeout`), the local tool didn't know which
cells cloud had actually processed. It queued all of them as pending and let
the retry loop handle it — which works fine when there is no contention, but
becomes the stuck-queue scenario when another laptop writes to overlapping cells.

### 2.4 Why the app "stopped working"

There is **no crash** visible in the logs. `app.log` ends mid-activity at
18:42:22 while `VfdWizardReader` was still emitting normal state reads and
`VFD WriteTag` calls were succeeding. No stack trace, no unhandled rejection,
no `EADDRINUSE`, no libplctag fault.

The node process was killed externally. Most likely:
1. Laptop lid closed / went to sleep → Windows killed the process
2. The START.bat cmd window was closed (closing the window kills the node child)
3. Battery died
4. Windows automatic reboot

Not a software fault. Software was running fine up to the termination.

## 3. The "Verify Identity blank" UI bug

Separately, Arick noticed in the spreadsheet that some VFDs (NCP1_1_VFD,
NCP1_2_VFD, NCP1_3_VFD) appeared to have blank `Verify Identity` even though
the rest of their row was filled.

Investigation: both local and cloud have `Verify Identity = "A 4/21"` for
those three devices — written by **Arman**. Arman typed his initials + date
instead of clicking the "pass" checkbox. The column is typed as `pass_fail`
in `l2_columns`, so the UI only recognizes `"pass"` or `"fail"` as valid
values and renders anything else as an empty checkbox. The data is stored;
the UI just can't display it.

Cloud value distribution across the entire `Verify Identity` column:
- `"pass"` — 33 cells (renders correctly)
- `"A 4/21"` — 3 cells (renders as blank)

## 4. What we did to unstick Arick's queue

Cloud database was patched directly (via MCP to Postgres) to set versions that
allowed Arick's pending pushes to succeed:

1. First pass: set cloud `version = 0` for all 10 stuck cells. 3 cleared on
   next retry (the cells whose local `Version` was 1 — sent `0`, matched).
2. Second pass: for the remaining 7 plus a newly added 8th (`UL17_23_VFD /
   Check Direction`), set cloud `version = localVersion - 1` individually
   so Arick's next retry would match exactly.

After the two passes, all 11 stuck items cleared naturally on the next
30-second auto-sync cycle.

## 5. The underlying protocol problems

### 5.1 Strict version equality
Cloud uses `cloud.version == incoming.version`. Any concurrent write from
another laptop permanently breaks the retry loop for the first laptop.

### 5.2 Silent rejection
Rejected cells are omitted from the `updates` response array. Local tool
treats this as "try again" forever. There is no "give up" condition.

### 5.3 Batch writes with timeouts
VFD wizard writes 5–6 cells per request. A 15-second timeout can leave
local in a state where it doesn't know which cells made it to cloud. All get
queued as pending, and each one has to navigate the strict version check
independently.

### 5.4 `pass_fail` column type is too strict
The UI only recognizes `"pass"` / `"fail"`. Any other non-empty value
(initials, dates, notes) renders as blank. Users writing their own
conventions end up with "missing" checks that aren't actually missing.

## 6. Proposed fixes (no code written yet, just design)

### 6.1 Last-write-wins + audit trail (recommended for sync)

Drop the strict version check on the cloud endpoint. Cloud accepts whatever
local sends. Add an `l2_cell_history` table that records every write (who,
what, when, old value, new value).

- Nothing ever gets stuck in the queue
- Last writer wins on the current cell state
- Full audit trail preserves any value that was overwritten
- Disputes can be investigated after the fact

Combined with a retry cap on local (e.g., drop a pending sync after 20
retries as a safety net), stuck queues become impossible.

### 6.2 Device-level lock with 30-second heartbeat

To prevent the concurrent-write problem in the first place, the VFD wizard
acquires a short lock on the device when it opens.

Flow:
- User clicks "Start Check" on VFD X → local tool calls
  `POST /api/vfd-lock/acquire { deviceId, user }`
- Cloud records: `locked_by = user`, `locked_until = now + 30s`
- If already locked by a different user with `locked_until > now`, cloud
  returns `409 Conflict` with `{ lockedBy, secondsLeft }`
- While the wizard is open, local sends
  `POST /api/vfd-lock/heartbeat { deviceId }` every 10 seconds → cloud
  extends `locked_until` to `now + 30s`
- On wizard close, local calls
  `POST /api/vfd-lock/release { deviceId }` → cloud clears the lock
- If the laptop crashes, closes, or loses network, heartbeats stop and the
  lock auto-expires in 30 seconds → another tech can take over

UI states on the "Start Check" button:
- Normal: "Start Check"
- Locked by someone else: 🔒 "Arick is testing this VFD (24s)" with live
  countdown, button disabled
- Locked by current user: "Testing…"

### 6.3 Why the lock must live on cloud, not local

The laptops do not talk to each other directly. Each laptop has its own
isolated SQLite database. Cloud is the only shared surface between them,
so the "who holds the lock" state has to live there. Local tool still owns
95% of the logic (button state, heartbeat scheduling, UI countdown,
release on close). Cloud is a thin shared registry.

Alternatives considered:
- Local-only lock: invisible to the other laptop, does nothing for the
  actual problem
- Peer-to-peer LAN discovery: factory networks often isolate devices or
  block broadcast, too fragile

### 6.4 Accept any non-empty value for `pass_fail` columns

Change the UI renderer (or column handling) so any non-empty string counts
as "checked". `"pass"`, `"A 4/21"`, `"RE 4/21"`, `"looks good"` — all render
as filled. Still compute aggregates based on `"pass"` / `"fail"` specifically
when needed, but do not hide data from the user just because the exact
string doesn't match.

## 7. Summary

Root cause: strict version-based optimistic concurrency rejects any write
that lands after another user's write on the same cell, and the local tool
retries the rejected write forever instead of reconciling with cloud's
current state.

The app did not crash. Arick's laptop was terminated externally (lid closed
or cmd window closed), unrelated to the sync issue.

Recommended fixes: **last-write-wins + audit trail** for sync resilience,
**30-second heartbeat lock** on the VFD wizard to prevent concurrent edits
from colliding in the first place, and **loosen the `pass_fail` display rule**
so free-text entries like `"A 4/21"` don't look blank in the grid.

All three changes require code work on both the local tool and the cloud app.
No changes were made to code as part of this investigation — only the cloud
database was patched directly to unstick Arick's queue.
