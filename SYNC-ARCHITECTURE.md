# IO Checkout Tool — Sync Architecture & Data Persistence

**Version:** 2.0
**Date:** 2026-03-18
**Purpose:** Explain how data syncing works when multiple technicians run independent copies of the tool on the same subsystem.

---

## How It Works — Overview

Each technician runs their own copy of the portable app on their own laptop. Every copy connects to the same PLC and pulls the same subsystem from cloud. Test results sync automatically in the background.

```
Technician A (laptop)          Cloud (PostgreSQL)          Technician B (laptop)
  ┌──────────┐                  ┌──────────┐                ┌──────────┐
  │ Local DB │ ──push (30s)──▶  │  Cloud   │  ◀──push (30s)─│ Local DB │
  │ (SQLite) │ ◀──pull (60s)──  │  Server  │  ──pull (60s)─▶│ (SQLite) │
  └──────────┘                  └──────────┘                └──────────┘
       │                                                          │
       └──── Both connect to same PLC via Ethernet/IP ────────────┘
```

**Key principle:** Your own test results are always saved locally first, then synced to cloud. You never lose data because of a network issue.

---

## Automatic Sync Cycles

Two background loops run automatically while the app is open:

### Push — Every 30 seconds
Sends your local test results to the cloud.

1. When you mark an IO as Pass/Fail, the result is saved to your local database **immediately**
2. A "pending sync" entry is also created in a queue
3. Every 30 seconds, the app checks this queue and sends all pending results to cloud
4. Only after the cloud confirms receipt are the queue entries removed
5. If cloud is unreachable, entries stay in the queue and retry next cycle

### Pull — Every 60 seconds
Fetches IO data from cloud, including other technicians' test results.

1. Every 60 seconds, the app fetches the latest IO data from cloud
2. IO definitions (name, description) are always updated from cloud
3. **Test results are merged with this rule:**
   - If you already tested an IO locally → **your result is kept** (never overwritten)
   - If you haven't tested an IO but cloud has a result (from another technician) → **cloud result is pulled in**
4. This means you see other people's work appear on your screen within ~90 seconds

---

## Multi-User Scenario: How Results Flow

### Normal workflow (technicians testing different IOs)

This is the expected case — each person works in a different area.

| Time | Person A | Cloud | Person B |
|------|----------|-------|----------|
| 0:00 | Tests IO #1 → Pass | — | Tests IO #51 → Pass |
| 0:30 | Auto-push sends IO #1 | Receives IO #1 (Pass) | Auto-push sends IO #51 |
| 0:30 | — | Receives IO #51 (Pass) | — |
| 1:00 | Auto-pull → sees IO #51 (Pass) from B | Has both | Auto-pull → sees IO #1 (Pass) from A |

**Result:** Both people see each other's work within ~90 seconds. No data loss.

### Edge case: Two people test the same IO

This should be rare (means two people are at the same panel), but it's handled:

| Time | Person A | Cloud | Person B |
|------|----------|-------|----------|
| 0:00 | Tests IO #5 → Pass | — | Tests IO #5 → Fail |
| 0:30 | Push → IO #5 = Pass | Receives Pass | Push → IO #5 = Fail |
| 0:35 | — | Receives Fail (overwrites Pass) | — |

**Result:** Cloud shows the last result pushed (whichever synced last). Both test attempts are recorded in the audit history (TestHistory table) and never lost. The cloud dashboard shows the final state.

**In practice:** If two people test the same IO differently, the last push wins on cloud. Both results exist in the local audit trail on each person's machine.

---

## What Happens When Things Go Wrong

### Cloud goes down
- **Your testing is not interrupted.** All results save locally.
- Push attempts fail silently; results stay in the queue.
- When cloud comes back, everything syncs automatically on the next 30-second cycle.
- No data is lost.

### Your laptop loses Wi-Fi
- Same as cloud down — local testing continues normally.
- Results queue up and sync when connectivity returns.

### Your laptop crashes or you close the terminal
- Any test result you already recorded is safe — it's in the local SQLite database.
- The pending sync queue is also in the database (not in memory), so it survives crashes.
- On restart, the auto-sync picks up where it left off.

### You click "Pull IOs from Cloud" manually
- This is different from the automatic 60-second pull.
- It **replaces** all local IO data with fresh cloud data.
- The app **warns you** if you have unsynced test results and blocks the pull until you sync.
- A backup of the database is created automatically before the pull.
- After the pull, your IOs are fresh from cloud (including any test results other people have synced).

---

## Data Safety Guarantees

| What | How it's protected |
|------|-------------------|
| Local test results | Saved to SQLite immediately when you click Pass/Fail |
| Sync queue | Stored in SQLite (survives crashes, restarts, power loss) |
| Cloud sync | Retries automatically every 30 seconds until successful |
| Other users' results | Merged into your local view every 60 seconds |
| Database corruption | WAL (Write-Ahead Logging) mode enabled for crash safety |
| Before manual pull | Automatic database backup created |
| Audit trail | Every test attempt recorded in TestHistory (never deleted) |

---

## PLC Connection

Multiple laptops can connect to the same Allen-Bradley PLC simultaneously. This is normal for Ethernet/IP — PLCs are designed to handle many concurrent connections (typically 32-128+). Each laptop opens its own independent connection.

All connected users see live PLC tag states in real-time (75ms read intervals via WebSocket).

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
| Mark IO as Pass/Fail | Saved locally → queued for cloud sync |
| Wait 30 seconds | Results pushed to cloud |
| Wait 60 seconds | Other users' results appear on your screen |
| Close the app | Data is safe in local database |
| Reopen the app | Auto-sync resumes, catches up |
| Cloud goes down | Local testing continues, syncs when cloud returns |
| Manual "Pull IOs" | Warns if unsynced, creates backup, refreshes from cloud |

---

## Summary

- **No dedicated server needed.** Each person runs their own copy.
- **No data loss.** Results are always saved locally first, then synced.
- **Automatic sync.** Push every 30s, pull every 60s — no manual action needed.
- **Multi-user safe.** Different IOs merge perfectly. Same IO = last push wins (both recorded in audit).
- **Crash safe.** SQLite WAL mode + persistent sync queue.
- **PLC safe.** Multiple simultaneous connections supported.
