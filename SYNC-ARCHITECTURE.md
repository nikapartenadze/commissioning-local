# IO Checkout Tool — Sync Architecture & Data Persistence

**Version:** 4.0
**Date:** 2026-04-14
**Purpose:** Explain how data syncing works when multiple technicians run independent copies of the tool on the same subsystem.

---

## How It Works — Overview

Each technician runs their own copy of the portable app on their own laptop. Every copy connects to the same PLC and pulls the same subsystem from cloud. Test results sync **instantly** to cloud on every action, with automatic background sync as a safety net.

```
Technician A (laptop)          Cloud (PostgreSQL)          Technician B (laptop)
  ┌──────────┐                  ┌──────────┐                ┌──────────┐
  │ Local DB │ ──instant push─▶ │  Cloud   │ ◀─instant push─│ Local DB │
  │ (SQLite) │ ◀──pull (60s)──  │  Server  │  ──pull (60s)─▶│ (SQLite) │
  └──────────┘                  └──────────┘                └──────────┘
       │              ▲                  ▲              │
       │              └── fallback 30s ──┘              │
       └──── Both connect to same PLC via Ethernet/IP ──┘
```

**Key principle:** Your own test results are always saved locally first, then synced to cloud instantly. If instant sync fails, a background retry picks it up within 30 seconds. You never lose data because of a network issue.

---

## Data Ownership

**The local field tool is the sole authority for test results.** The cloud app is a receiver and dashboard — it never modifies pass/fail/comment data.

| Data | Owner | Cloud role |
|------|-------|------------|
| IO definitions (name, description, order) | Cloud | Source of truth |
| Test results (pass, fail, cleared) | Local tool | Cloud is read-only receiver |
| Comments | Local tool | Cloud is read-only receiver |
| Audit history (TestHistory) | Both | Append-only on both sides |

**Cloud always accepts local tool pushes — no version gating, no rejection.** If two local tools push for the same IO, both pushes succeed (last write wins on cloud, both preserved in audit history). The cloud UI does not expose pass/fail/clear controls.

---

## Sync Behavior

### Instant Push — On Every Action
When you mark an IO as Pass/Fail, add a comment, or reset a result:

1. The result is saved to your local database **immediately**
2. A "pending sync" entry is created in a queue (safety net)
3. The app **immediately attempts to push** the result to cloud
4. If the push succeeds, the queue entry is removed
5. If the push fails (cloud unreachable, network issue), the queue entry stays for background retry

This means cloud typically receives your result within **1-2 seconds** of you clicking Pass/Fail.

### Background Push — Every 30 seconds (Fallback)
A background loop drains any remaining pending sync entries:

1. Every 30 seconds, the app checks the pending sync queue
2. Any entries that failed instant sync are retried in batch
3. Only after the cloud confirms receipt are the queue entries removed
4. This is a safety net — most results will have already synced instantly

### Pull — On SSE reconnect only (no polling)
The app does **not** poll cloud on a timer. Instead, it relies on the real-time SSE connection for live updates. A full pull only happens when the SSE connection (re)connects, to catch any events missed during a disconnect.

1. When the SSE connection establishes or re-establishes, the app fetches the latest IO data from cloud
2. IO definitions (name, description) are always updated from cloud
3. **Test results are merged with this rule:**
   - If you already tested an IO locally → **your result is kept** (never overwritten)
   - If you haven't tested an IO but cloud has a result (from another technician) → **cloud result is pulled in**
4. Between reconnects, individual IO updates arrive in real-time via SSE (typically within 1-2 seconds)

---

## Live Cloud Dashboard

The cloud web dashboard (commissioning.lci.ge) updates **in real-time** when field tools push test results — no manual page refresh needed.

- The dashboard connects to the cloud server via **Server-Sent Events (SSE)** at `/api/sync/events`
- When any local tool pushes a pass/fail/comment/reset, the cloud broadcasts the update to all open dashboards
- Off-site engineers see results appear within 1-2 seconds of a technician testing on site
- The SSE connection auto-reconnects if it drops (e.g., network blip)
- Zero performance impact — SSE is a single persistent HTTP connection per browser tab

---

## Multi-User Scenario: How Results Flow

### Normal workflow (technicians testing different IOs)

This is the expected case — each person works in a different area.

| Time | Person A | Cloud | Person B |
|------|----------|-------|----------|
| 0:00 | Tests IO #1 → Pass | — | Tests IO #51 → Pass |
| 0:01 | Instant push sends IO #1 | Receives IO #1 (Pass) | Instant push sends IO #51 |
| 0:01 | — | Receives IO #51 (Pass) | — |
| 1:00 | Auto-pull → sees IO #51 (Pass) from B | Has both | Auto-pull → sees IO #1 (Pass) from A |

**Result:** Cloud has both results within seconds. Each person sees the other's work within ~60 seconds.

### Edge case: Two people test the same IO

This should be rare (means two people are at the same panel), but it's handled:

| Time | Person A | Cloud | Person B |
|------|----------|-------|----------|
| 0:00 | Tests IO #5 → Pass | — | Tests IO #5 → Fail |
| 0:01 | Instant push → IO #5 = Pass | Accepts Pass (v→v+1) | Instant push → IO #5 = Fail |
| 0:02 | — | Accepts Fail (v→v+1) | — |

**Result:** Cloud always accepts both pushes — last write wins on the dashboard. Both test attempts are recorded in the audit history (TestHistory table) on cloud and on each person's machine. No sync is ever rejected.

**In practice:** Two people testing the same IO is rare. When it happens, the last push to arrive is what shows on the dashboard. Both results exist in the audit trail everywhere.

---

## PLC Connection & Auto-Reconnect

Multiple laptops can connect to the same Allen-Bradley PLC simultaneously. This is normal for Ethernet/IP — PLCs are designed to handle many concurrent connections (typically 32-128+). Each laptop opens its own independent connection.

All connected users see live PLC tag states in real-time (75ms read intervals via WebSocket).

### Auto-Reconnect on Connection Loss

Once a PLC connection is configured and established, the tool automatically reconnects if the connection is lost (PLC power cycle, network interruption, router restart):

- **Detection:** The tag reader detects consecutive read failures and marks the connection as lost
- **Retry:** Automatically attempts to reconnect every 5 seconds
- **Resume:** On successful reconnection, tag reading and testing mode resume automatically
- **UI indicator:** The toolbar shows an amber spinning icon with "Reconnecting" text during retry
- **No admin intervention required** — the admin does not need to log in and manually reconnect
- **Intentional disconnect** (clicking the disconnect button) stops auto-reconnect

This covers the common scenario where power is lost to the panel, router, or server laptop — when any of them come back online, the connection restores automatically.

---

## What Happens When Things Go Wrong

### Cloud goes down
- **Your testing is not interrupted.** All results save locally.
- Instant push attempts fail silently; results stay in the queue.
- When cloud comes back, the background sync pushes everything within 30 seconds.
- No data is lost.

### Your laptop loses Wi-Fi
- Same as cloud down — local testing continues normally.
- Results queue up and sync when connectivity returns.

### PLC loses power or network
- The tool detects the connection loss and begins auto-reconnecting every 5 seconds.
- Testing mode pauses but resumes automatically when the PLC comes back.
- No manual intervention needed — no admin login required to hit "connect."
- Any test results already recorded are safe in the local database.

### Your laptop crashes or you close the terminal
- Any test result you already recorded is safe — it's in the local SQLite database.
- The pending sync queue is also in the database (not in memory), so it survives crashes.
- On restart, the auto-sync picks up where it left off.

### You click "Pull IOs from Cloud" manually
- This is different from the automatic 60-second pull.
- It **replaces** all local IO data with fresh cloud data.
- If you have unsynced test results, the app **automatically syncs them to cloud first**, then pulls. No manual steps needed.
- A backup of the database is created automatically before the pull.
- After the pull, your IOs are fresh from cloud (including any test results other people have synced).

### Cloud settings after restart
- Your cloud URL, API password, and subsystem ID are saved to `config.json` after every successful pull.
- When you restart the app, these settings are loaded automatically — no need to re-enter them.

---

## Database Backups

The app automatically creates a full backup of your local database before any destructive operation.

### When backups are created
- **Before every manual "Pull IOs from Cloud"** — the database is copied to the `backups/` folder before any data is replaced
- **Manual backups** — available through the app's backup API if needed

### What's in a backup
Each backup includes three files:
- `database-{timestamp}-{reason}.db` — the main database
- `database-{timestamp}-{reason}.db-wal` — the write-ahead log (if active)
- `database-{timestamp}-{reason}.db-shm` — shared memory file (if active)

### Where backups are stored
Backups are saved in the `app/backups/` folder inside your portable directory. They are named with a timestamp and reason, e.g.:
```
database-2026-03-19T10-28-02-pre-pull.db
```

### Recovery
If something goes wrong, you can restore by copying a backup file back as `database.db` in the `app/` folder (with the app stopped).

---

## Audit Trail (TestHistory)

Every test attempt is permanently recorded in the `TestHistory` table — even if the IO is later retested, reset, or the result is overwritten by another user's sync. This table is **never deleted or modified**.

Each entry records:
- Which IO was tested
- Pass or Fail result
- Who tested it (testedBy)
- When it was tested (timestamp)
- The PLC state at the time of testing
- Any comments or failure mode selected

This means even in the rare case where two people test the same IO and one result overwrites the other, **both test attempts exist in the audit history**.

---

## Data Safety Guarantees

| What | How it's protected |
|------|-------------------|
| Local test results | Saved to SQLite immediately when you click Pass/Fail |
| Cloud sync (primary) | Pushed to cloud instantly on every action (~1-2 seconds) |
| Cloud sync (fallback) | Background retry every 30 seconds for any failed instant syncs |
| Sync queue | Stored in SQLite (survives crashes, restarts, power loss) |
| Other users' results | Received in real-time via SSE; full catch-up on reconnect |
| PLC connection | Auto-reconnects every 5 seconds on connection loss |
| Database corruption | WAL (Write-Ahead Logging) mode enabled for crash safety |
| Before manual pull | Automatic database backup created in `app/backups/` |
| Audit trail | Every test attempt recorded in TestHistory (never deleted, never modified) |
| Unsynced data protection | Manual pull auto-syncs pending results first, then pulls |
| Config persistence | Cloud URL, password, subsystem ID saved to config.json — survives restarts |
| Backup includes WAL | Backup copies all 3 database files for complete consistency |
| Comment sync | Comments are synced to cloud on every update (previously missing) |

---

## Ports Used

| Port | Purpose |
|------|---------|
| 3000 | Web app (HTTP) — open this in the browser |
| 3002 | WebSocket (real-time PLC state updates) |

Both ports need to be accessible. Firewall rules are set up automatically on first run.

---

## Quick Reference

| Action | What happens |
|--------|-------------|
| Mark IO as Pass/Fail | Saved locally → instantly pushed to cloud |
| Add/edit comment | Saved locally → instantly pushed to cloud |
| Reset IO | Saved locally → instantly pushed to cloud |
| Cloud unreachable | Result queued, background retry every 30s |
| Other user tests IO | Their result appears on your screen in real-time via SSE |
| PLC power loss | Auto-reconnects every 5s, resumes testing |
| Close the app | Data is safe in local database |
| Reopen the app | Auto-sync resumes, catches up |
| Cloud goes down | Local testing continues, syncs when cloud returns |
| Manual "Pull IOs" | Auto-syncs pending results, creates backup, refreshes from cloud |

---

## Summary

- **No dedicated server needed.** Each person runs their own copy.
- **No data loss.** Results are always saved locally first, then synced.
- **Instant sync.** Results pushed to cloud within 1-2 seconds of every action.
- **Automatic fallback.** Background retry every 30s for any failed syncs. Pull on SSE reconnect.
- **Multi-user safe.** Different IOs merge perfectly. Same IO = last push wins (both recorded in audit). Cloud never rejects.
- **Local tool is leader.** Cloud always accepts test results. No version gating, no silent rejections.
- **Auto-reconnect.** PLC connection recovers automatically — no admin login needed.
- **Crash safe.** SQLite WAL mode + persistent sync queue.
- **PLC safe.** Multiple simultaneous connections supported.
