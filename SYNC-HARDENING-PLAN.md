# Sync / Storage / Forensics Hardening Plan — 2026-07-08

Synthesis of four parallel audits (offline capability, full sync contract, forensics &
restoration, industry best-practice research). Full reports were generated during the
2026-07-08 session; the durable copies of their content are reflected here.

## Verdict

The architecture is **fundamentally sound** — local-first writes + durable outbox +
monotonic LWW gate + SSE-as-hint + cursor delta (IO) is the same shape PouchDB,
Firestore, Replicache and Salesforce Field Service converged on. CRDTs / event
sourcing / HLC are correctly avoided. The 2026 incidents were violations of two
consensus rules — "a pull never destroys unacknowledged local work" and "deletes are
explicit facts, not inferred from full-state replace" — both now fixed (FV, v2.43.0)
or planned (IO tombstones).

Scores at audit time: offline capability **18 SOLID / 5 stalls / 0 broken**;
sync flows **18 SOLID / 10 ACCEPTABLE / 3 RISKY / 3 missing channels**;
forensics **~40% of mutation classes trailed, ~15% reconstructable end-to-end**.

## Shipped 2026-07-08 (same day as the audits)

- Field v2.43.0: non-destructive FV pull (structure down / values up-only /
  fill-empty-only incl. belt-tracked handoff), guarded device prune, IO clear guard,
  VFD Valid_Map→Valid_HP chain, FV view fixes.
- Cloud: deterministic L2 template + `authoritativeComplete` (deployed, verified live).
- Offline stalls: firmware-baseline fetch 10s timeout; change-request submit
  fire-and-forget; MCM picker 3s fallback; VFD badges local-first.
- Outbox: class-aware coalesce (punchlist/dependencies ops no longer destroyed by a
  later Pass/Fail); instant-path permanent rejects now PARK (last hard-delete gone).
- Removed field `/api/sync/update` (dead, unauthenticated LAN write hole).
- Cloud: L2 imports now recordChange + SSE-hint every project subsystem (imports were
  invisible to the field); CSV-import delete ledger moved to `audit_logs.details.deletedIos`
  (io_change_history FK-cascade made delete history impossible — live void bug fixed).

## P0 — do next (ops + high-value)

1. **Off-host prod backup is DEAD.** dockerhost has a healthy local chain (2-hourly
   pg_dump, daily dumpall, Backrest/restic 7d/4w/6m) but the restic repo is on the
   SAME disk and `/mnt/nas-backup` does not exist — silently skipped, no alert.
   → Remount/replace the NAS target (needs credentials — operator action), add
   failure alerting, and drill one restore. Single-host loss currently = total loss.
2. **Schedule the change-log prune**: `/api/cron/prune-change-log` exists but has no
   caller — dockerhost cron POST w/ `x-reports-key` (REPORTS_CRON_SECRET), weekly.
3. **WAL-G / PITR on dockerhost** (~1 day): answers "rows wiped at 14:37, noticed at
   16:00" which nightly dumps cannot. Best-practice agent rated this the top
   infra-value item.

## P1 — code (next release batch)

4. **FV cursor delta** (design in audit): `l2_cell`/`l2_device` change-log rows
   (writers: sync/l2/update, L2 import, belt-tracking toggle),
   `GET /api/sync/l2/[id]/changes?since=cursor` + resync watermark, second
   SyncCursors kind, version-gated LWW cell apply (transplant computeSseIoUpdate) —
   gives peer-tablet FV convergence + delta bandwidth without reopening the wipe class.
5. **E-stop/safety RESULTS down-flow**: recordChange on estop-checks POST + results in
   the estop pull + version-gated apply. Today a replaced tablet cannot recover
   safety-check results and peers never converge.
6. **IO delete tombstones**: propagate IO/config deletes via change-log `delete`
   entries (plan exists: docs/superpowers/plans/2026-06-23-cloud-to-field-delta-sync.md),
   demote the global destructive full pull to explicit operator-confirmed bootstrap.
7. **Stop history self-destruction**: field `TestHistories ON DELETE CASCADE`
   (db-sqlite) and cloud `io_change_history`/`testhistories`/`l2_cell_history`
   cascades die exactly when needed. Field: SQLite table rebuild dropping the FK.
   Cloud: schema change (needs schema-guard sha bump) → `onDelete: SetNull` or no FK.
8. **Network-status disconnected-clobber guard** (auto-sync ~1846): add the same
   last-known-good guard e-stop status has.
9. **Journal the unjournaled**: VFD wizard L2 writes/clears, PLC-driven mark-passed,
   punchlist triage, VFD blocker set/clear (row DELETE loses existence), cloud e-stop
   upserts, access-key role changes (privilege escalation is invisible today).

## P2 — hardening / hygiene

10. Op-UUID idempotency on cloud `/api/sync/update` + keep `lte` gate → cleanly kills
    the version-deadlock class (B7 then becomes belt-and-suspenders).
11. Mass-delete circuit breaker: any reconcile/import deleting > N rows (say 50)
    requires explicit confirmation; soft-delete grace period instead of hard delete.
12. SQLite backups via `VACUUM INTO` (WAL-consistent) instead of file copy.
13. Ship field JSONL journals to cloud (forensics survive tablet loss/theft).
14. Restore tooling: field restore endpoint (backup list → restore + restart), cloud
    documented `pg_restore` runbook; delete the dead backups/[filename]/sync route.
15. First-provision UX (mcm-connect): show "pulling subsystem…" progress instead of a
    silent up-to-90s wait; cap cloud attempt when offline.
16. Doc drift: SYNC-CONTRACT.md (park-not-delete, VfdCommissioningBlocker, L2 rules,
    change-log/cursor mechanism), root CLAUDE.md references a non-existent
    SYNC-ARCHITECTURE.md.

## Standing invariants (do not regress)

- A pull NEVER deletes/overwrites a filled local value (FV) or an operator result (IO).
- Every queue parks (DeadLettered=1) — nothing hard-deletes un-acked field work.
- Every destructive-class operation journals to the recovery JSONL before acting.
- Cloud deploys: push to gitlab main only (auto-deploy, health-check, rollback).
- Field releases: tag + GitHub release with installer asset; badge needs APP_VERSION.
