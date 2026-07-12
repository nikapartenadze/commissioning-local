# Data Recovery Runbook — Commissioning Platform

**Purpose:** if data ever looks lost or sync misbehaves, this is the context and the exact
steps to find and recover it. The design goal is that you never need this — but when you do,
follow it top to bottom before concluding anything is truly lost.

---

## 0. The one mental model that matters

**Test results are almost never actually lost — they are in one of three places:**
1. **On the field tablet** — local SQLite is the *authority* for results, and `TestHistories`
   is an **append-only, immutable ledger** (every pass/fail/clear ever recorded).
2. **On the cloud** — if it synced (push is immediate; the periodic sweep + reconciler catch the rest).
3. **In a backup** — a fresh `.db` snapshot is taken automatically *before every destructive pull*.

**Check all three before declaring loss.** A missing value in the live `Ios.Result` column does
**not** mean the result is gone — the `TestHistories` ledger still has it.

---

## 1. Where the data lives

| Data | Field (local, authority for results) | Cloud (receiver + dashboard) |
|---|---|---|
| Test results | `Ios.Result` + `TestHistories` (ledger) in `database.db` | `ios`, `test_histories`, `io_change_history` |
| L2 / FV cells | `L2CellValues` | `l2_cell_values`, `l2_cell_history` |
| Sync queue | `PendingSyncs`, `L2PendingSyncs`, `*PendingSyncs` (outboxes) | — |
| Change feed | (consumes) | `subsystem_change_log` (per-subsystem seq cursor), `audit_logs` |
| Backups | `backups/*.db` (auto pre-pull, `VACUUM INTO`, ~30 retained) | DB backups + `/api/admin/backup/[projectId]` |
| Forensics | `logs/app.log` (per-MCM tagged), recovery-log JSONL, journal | `audit_logs`, `io_change_history` |

- **Field DB path:** beside the config — portable mode = app folder; installer mode =
  `C:\ProgramData\CommissioningTool\database.db` (+ `backups/`, `logs/`). Overridable via `CONFIG_PATH`/`DATABASE_URL`.
- **Cloud DB (prod):** the `commissioning-db` Postgres container on dockerhost (verify prod ONLY there — `ssh dockerhost` → `docker exec … psql`). The Azure `.env.local` URL is stale.

---

## 2. Golden rules (do this first, always)

1. **Before ANY destructive action** (pull, restore, reset): confirm a backup exists in `backups/`
   and copy the newest one somewhere safe.
2. **Never delete a backup or a `PendingSyncs` row** to "clean up." Parked rows (`DeadLettered=1`) are
   preserved on purpose and self-heal.
3. **Stop the tool before restoring a DB file** (services or `STOP.bat`), or the WAL will fight you.
4. **Local is authority for results.** If field and cloud disagree on a result, the field's local
   value + its `TestHistories` is the source of truth (last-write-wins by recency, both preserved).

---

## 3. Scenarios & recovery steps

### A. "A result I marked is missing on the field"
1. Look in the ledger — it's immutable:
   `SELECT * FROM TestHistories WHERE IoId = <id> ORDER BY Timestamp DESC;` (via `sqlite3 database.db`).
   The result is here even if `Ios.Result` was later cleared/overwritten.
2. If the ledger is empty too, check the newest pre-pull backup:
   compare `backups/database-<newest>.db` (a wiping pull would have snapshotted the prior state).
3. Check the cloud (it likely synced): the delta pipeline + periodic sweep should show it on the dashboard.
   If it's on the cloud but not the field, force a re-sync (Scenario C).

### B. "Field is stuck — results not pushing to cloud"
1. Inspect the outbox: `SELECT COUNT(*), DeadLettered FROM PendingSyncs GROUP BY DeadLettered;`
   - `DeadLettered=0` = active retry (pushes every ~10s). `=1` = **parked** (hit the retry cap) — NOT lost;
     the B7 reconciler rebases parked rows against cloud truth and un-parks them.
2. Check connectivity + credentials (Cloud status button; the api key must match the project).
3. Nothing is deleted while offline — results accumulate locally and drain when the cloud returns.
   The result-reconciler also re-enqueues any orphaned results on SSE reconnect / the 15-min safety sweep.
4. If a specific row is genuinely stuck, it will show in the "not communicating / needs attention" surface;
   its `LastError` (now per-MCM tagged in `app.log`) tells you why (e.g. a permanent reject like SPARE-passed).

### C. "A cloud change (Addressed / belt-tracking / import) isn't showing on a tablet"
1. **Wait ~2 minutes** — the periodic delta sweep re-fetches every managed subsystem's changes even if the
   live SSE hint was missed. This is the safety net.
2. Force it now: toggle the tablet's network (SSE reconnect triggers an immediate catch-up), or run a
   scoped pull for that MCM.
3. If it *still* never arrives, the cloud mutation may not be recording a change — verify the endpoint
   calls `recordChange` + `broadcastSubsystemChanged` (the coverage-gap fixes closed the known ones).
4. Cold cursor / long-offline tablet: the delta endpoint returns a **non-destructive resync snapshot** —
   it rebuilds from cloud without wiping local results (result-authority preserved).

### D. "A pull wiped local data" (the cardinal incident)
1. **STOP the tool immediately.** Do not pull again.
2. A backup was taken automatically *before* the pull. Find the newest one *older than the wipe*:
   `ls -t backups/database-*.db`.
3. With the tool stopped, restore: copy that backup over `database.db` (and remove `database.db-wal`/`-shm`).
4. Restart. The guards that now prevent this: the multi-MCM fence (F1), result-loss 409, at-risk/clear-reversion
   checks, and the non-destructive delta path — a destructive pull refuses when it would lose un-synced local work.

### E. "Cloud data looks wrong/lost"
1. The field is authority for results — re-push from the field tablets (they hold the local truth).
2. Cloud has its own DB backups + the per-project export/backup route; restore there if needed.
3. `audit_logs` + `io_change_history` + `subsystem_change_log` on the cloud give the full change history to
   reconstruct what happened and when.

---

## 4. Reconcile: compare field vs cloud for one subsystem

- **Field:** `sqlite3 database.db "SELECT Result, COUNT(*) FROM Ios WHERE SubsystemId=<id> GROUP BY Result;"`
- **Cloud (prod):** `ssh dockerhost` → `docker exec -i commissioning-db psql -U <u> -d <db> -c "SELECT result, count(*) FROM ios WHERE subsystemid=<id> GROUP BY result;"`
- A per-IO diff of `Ios.Result`+`Version`+`Timestamp` (field) vs `ios` (cloud) tells you exactly which rows diverge and which side is newer.

---

## 5. What already prevents loss (so this runbook stays unused)

- **Offline-first + local authority:** results write locally first; cloud is a receiver. Works with no internet after pull.
- **Append-only `TestHistories` ledger** — results are never overwritten in the audit trail.
- **Auto pre-pull backups** (`VACUUM INTO`, retained), **park-not-delete** sync queue, **dual pull-guards**
  (result-loss 409 + at-risk/clear-reversion), **non-destructive delta apply** with a bulk-delete circuit breaker.
- **Cloud→field:** durable `subsystem_change_log` outbox + cursor + SSE hint + **periodic delta sweep**
  (≤~2 min even if a hint is lost) + non-destructive resync — every cloud mutation now records a change and propagates.
- **Known residual (narrow):** the field DB runs `synchronous=NORMAL` for performance, so a hard power-loss in the
  split second before a WAL checkpoint can lose the *single* most-recent result. Everything else is durable.
  (Mitigation if wanted: fsync the recovery-log, or `synchronous=FULL` at a perf cost.)

---

*Keep this with the tool. First move in any incident: don't pull, take a backup, check the three places (Section 0).*
