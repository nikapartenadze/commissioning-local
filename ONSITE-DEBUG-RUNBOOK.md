# Onsite Debug Runbook

**A living reference for diagnosing the field commissioning tool from a real box's logs + database.**
Update this every time we debug an onsite incident — add new symptoms, grep patterns, and gotchas as we learn them. The goal: next time, look for the right things fast instead of re-deriving.

> Last major update: 2026-07-16 (MCM04 CDW5 forensics — see `.claude/.../memory/project_mcm04_log_forensics_2026_07_16.md`).

---

## 0. Golden rules (hard-won)

1. **VERIFY, don't assume.** Correlation ≠ causation. This session an agent "confirmed" a crash-loop from restart-file counts + a log line; the code disproved every premise. Read the code before certifying a diagnosis or a fix.
2. **Huge logs: NEVER `cat`/read whole.** App/error logs are 5–20 MB (100k–200k lines/day). Use `grep`/`awk`/`wc` with counts + tiny samples. For a multi-artifact dump, dispatch one agent per artifact class (app / errors / service+gateway / db+audit) in parallel — tell each to summarize, never dump.
3. **A logged error is not always fatal.** `[PlcClient] Unhandled error event: …` is emitted by a **defensive listener** (since commit 5a5bf16) — it does NOT crash the process. A real crash shows a JS stack trace / `uncaughtException` / `FATAL`. If those are absent across 500k+ lines, it did not crash.
4. **Restarts are often operational, not crashes.** NSSM restarts on any exit. Sources: cloud-commanded fleet restart (`process.exit(0)` in `lib/heartbeat/command-handler.ts`), installer upgrades (`install-history.log`), operator manually restarting. Rule out these before hunting a code crash.

---

## 1. Where the logs live (installer mode)

`C:\ProgramData\CommissioningTool\` (portable mode: beside the app folder). Resolved by `frontend/lib/storage-paths.ts`.

| File | What it is | Read for |
|---|---|---|
| `logs/app-YYYY-MM-DD.log` | Main application log (INFO+). Huge. | PLC connect/disconnect lifecycle, VFD writer passes, boot/auto-connect, health |
| `logs/errors-YYYY-MM-DD.log` | WARN+ERROR only. Huge (much is WARN). | Error histograms, NetworkPoller timeouts, connection errors |
| `logs/tag-events-*.log` | PLC tag change telemetry | Tag-level read behavior |
| `logs/audit-YYYY-MM-DD.jsonl` | Structured audit journal | `sync.pull`, `l2.cell`, `io.test`, `plc.connect/disconnect`, `vfd.blocker` ops |
| `service-*.log` / `service-error-*.log` | NSSM stdout/stderr, **one pair per (re)start** | Restart timeline (count the files!), crash-time last lines |
| `gateway.log` / `gateway-error.log` | Split-gateway process (only if `PLC_MODE=remote` era) | Whether gateway was healthy vs the app-side 503s |
| `install-history.log` | Version upgrade timeline | Correlate behavior changes to a version bump |
| `journal-upload-state.json` | Audit-journal upload cursor | Which audit lines reached cloud |
| `config.json` | Runtime config (see §4) | The MCM list, IPs, paths, cloud URL/key |
| `database.db` (+ `-wal`, `-shm`) | The field SQLite DB (WAL mode) | Queue state, results, per-MCM data |
| `backups/` | Pre-pull + pre-bulk-discard `.db` snapshots, and `sync-discard-*.txt` records | Recovery + "what did a discard clear" |

**Getting a box's data:** operator copies `logs/ config.json database.db*` into a folder (e.g. repo-root `mcm04/`). Then analyze there.

---

## 2. Fast triage by symptom

| Symptom | Look here first |
|---|---|
| "PLC keeps disconnecting/reconnecting" | Is it real per-MCM churn or the UI aggregate? `grep 'Cannot reach PLC'`, `grep 'MCM .* (re)connected'` per MCM. The **banner** was a global-aggregate bug (fixed 2026-07-16). |
| "Config window says connected but it's not" | Fixed 2026-07-16 (`resolvePlcConnectionView`). If pre-v2.43.4, it's the global `anyConnected` aggregate. |
| Log firehose / disk filling | `[NetworkPoller] … Read failed: Timeout/Busy` = 94–98% of volume. De-spam fix f3bf348 collapses Timeout/Busy. Pre-fix: alternating status defeated de-spam. |
| "VFD wizard messed up / blockers vanish" | `vfd.blocker {op:'clear'}` in `audit-*.jsonl` right after a `Run Verified` write = the 0ceecd4 wipe (guarded by 44bc318). |
| VFD `Tracking_Finished: Bad parameter` spam | Tag absent from AOI; retried every pass. Fixed a887a0d (cache BAD_PARAM/UNSUPPORTED). |
| Service restart loop | Count `service-*.log` files. Then: any JS stack trace / `uncaughtException` / `FATAL`? If none → operational (see Golden Rule 4), not a code crash. |
| Sync stuck / parked rows | See §3 (DB queue tables) + the in-app Sync Center (per-MCM as of e14b4cd). |
| "0 success, N failed, PLC reachable" spinning | Program changed → 0/N tags match. `isTransientZero` retries forever; 6b61cd3 backs it off to 5 min. |

### Useful grep patterns
```bash
# connection lifecycle per MCM
grep -E "Cannot reach PLC|(re)connected|Boot AutoConnect|PLC_MODE" logs/app-*.log
# error histogram (normalize then count)
grep -oE "\[(WARN|ERROR)\].*" logs/errors-*.log | sed -E 's/[0-9.]+//g' | sort | uniq -c | sort -rn | head
# real crashes only
grep -E "uncaughtException|unhandledRejection|FATAL|^\s+at " logs/service-error-*.log
# VFD blocker clears (the wipe)
grep -i "blocker" logs/audit-*.jsonl
```

---

## 3. The field database (read-only)

**Never write/checkpoint/VACUUM a field DB you're investigating.** Open read-only:
```bash
node -e "const D=require('./frontend/node_modules/better-sqlite3'); const db=new D('database.db',{readonly:true}); console.log(db.prepare('SELECT name FROM sqlite_master WHERE type=\"table\"').all())"
```

Key tables:
- **Data (the real values):** `Ios` (per-IO results, `SubsystemId`), `L2CellValues` / `L2Devices` (FV/VFD, `SubsystemId` nullable-legacy), `TestHistories` (audit trail — must survive a pull), `Subsystems` (id ↔ Name/MCM).
- **Outbound queue (cloud-sync copies):** `PendingSyncs` (IO, via `Ios.SubsystemId`), `L2PendingSyncs` (via `L2Devices.SubsystemId`), `DeviceBlockerPendingSyncs` (`SubsystemId`), `EStopCheckPendingSyncs`, `GuidedTaskStatePendingSyncs`. States: `DeadLettered=0` pending, `=1` parked, `Orphaned=1` removed-on-cloud.
- Queue rows are OUTBOUND COPIES — discarding one never deletes the underlying value.

Per-MCM: everything above is attributable by `SubsystemId`. The Sync Center (`lib/sync/queue-inspector.ts`) and scoped pull (`/api/mcm/:id/pull`) operate per-MCM; a stuck MCM never head-of-line-blocks another.

### Cloud DB (production)
Via the `commissioning-db` MCP (`mcp__commissioning-db__execute_sql`) — this is **live prod** (verify with max timestamps). Notes:
- `VfdCommissioningBlocker` = current-state only, **hard delete, NO history/audit** — a wiped blocker's content is unrecoverable; only the *removal event* shows in `subsystem_change_log` (`entity_type='vfd_blocker'`, op='update', no before-image).
- `audit_logs` does NOT cover blockers.
- Real prod DB host: `commissioning-db` on dockerhost (see `reference_commissioning_db_mcp` memory); Azure is stale.

---

## 4. config.json gotchas (multi-MCM / CDW5)

- `mcms[]` lists every MCM with `subsystemId`, `name`, `ip`, `path`, `enabled`.
- **A blank `ip` with `enabled:true` is INERT** — the tool skips it, zero errors. (Do NOT chase a "blank-IP connection storm" — it doesn't exist.)
- **Routed paths** like `1,0,18,10.49.56.27` route THROUGH one controller (Ethernet-out port 18). Several MCMs sharing one physical controller IP (e.g. `11.200.1.1`) fan all their reads at ONE CIP queue → saturation → poll timeouts + the `isTransientZero` race. Scoping the config to reachable MCMs relieves it.
- Top-level `ip`/`subsystemId` empty is normal for the central multi-MCM build.

---

## 5. Split gateway vs embedded

- **Embedded (v2.43.3+, default):** one process owns all per-MCM PLC connections. Correct topology.
- **Split (`PLC_MODE=remote`):** separate `CommissioningGateway` on :3200. The gateway process itself was healthy in the field; what broke was the **functional layer** — `wizard-open → 503` (app owns no PLC handle in remote mode), silent write failures through the hop, and unset `GATEWAY_SECRET`/`BROADCAST_SECRET`. Prefer embedded.

---

## 6. Releases

- Fixes on `main` are NOT in any installer until a **new build** is cut. The EXE version is baked at build time (`install-history.log` shows what a box runs).
- PLC-adjacent changes (`lib/plc/**`, network poller, reconnect, VFD writer) are **high-risk — validate on hardware/battle before shipping** (`CLAUDE.md`).
- Always commit + push `commissioning-local` to **both** remotes (origin=github, gitlab) — uncommitted work has been lost before.

---

## 6b. Migrations & schema changes (READ before changing schema)

Two SEPARATE systems — never conflate:

| | LOCAL SQLite (field tool) | CLOUD data provisioning |
|---|---|---|
| Where | `frontend/lib/db-sqlite.ts` | `commissioning-cloud/scripts/add-*-column.ts`, `lib/l2-synthetic-columns.ts` |
| Runs | **Auto, every startup** (install applies it) | **Manual** — must be run on prod explicitly |
| Adds | Table columns/tables (`ALTER TABLE ADD COLUMN`, `CREATE TABLE IF NOT EXISTS`) | DATA rows (e.g. the "Run Verified" L2 column) |
| Field gets it via | Installing the new build | Cloud provision **+ a field PULL** (redeploy does NOT add data rows) |

- **Adding a local table column?** Idempotent `ALTER TABLE ... ADD COLUMN` in db-sqlite.ts. Ships with the build.
- **Adding a spreadsheet/L2 column (or other cloud data)?** Run the cloud script on prod, THEN pull on the field. A redeploy alone will NOT add it — this is exactly why "Run Verified" 422s (`write-l2-cells/route.ts` drops an unmapped column).
- **Cloud Postgres SCHEMA column (a third case):** `commissioning-cloud/scripts/add-*-column.sql` applied manually on dockerhost (`docker exec -i commissioning-db psql ...`), Prisma schema + `schema.prisma.sha256` re-blessed in the same commit, and the field only *sees* the value if BOTH sync serializers (`sync/subsystem/[id]` and `.../changes`) emit it. Example: `planned_date` (2026-07-21, see `docs/PLANNED-DATES-CONTRACT.md`) — local mirror is `Ios.PlannedDate TEXT`, cloud-owned, applied directly by pull/delta with no local-authority guard.
- **DATA SAFETY:** local startup migrations run on EVERY boot — a `DELETE`/rewrite there wipes operator data repeatedly (real incident: Belt Tracked migration, fixed in `5a5bf16`). **Never** put destructive SQL in the startup path; verify a backup first.
- A missing L2 column **drops** the write (422, no queue row) — it is NOT a queue-stuck/park condition.
- A PostToolUse hook (`.claude/hooks/migration-reminder.sh`) injects this checklist whenever a schema/migration file is edited.

### DB-perf pass (2026-07-24) — new indexes + one-time L2Columns normalization

All LOCAL (`frontend/lib/db-sqlite.ts`), auto-run on startup, additive + idempotent:

- **New indexes** (`CREATE INDEX IF NOT EXISTS`, created AFTER the ALTER loop because
  `L2Devices.SubsystemId` is migration-added): `idx_l2sheets_cloudid`,
  `idx_l2columns_cloudid`, `idx_l2devices_cloudid` (cloud↔local join key — pull-l2
  upserts, SSE/auto-sync drains, Sync Center), `idx_l2devices_subsystemid` (per-MCM
  L2 scoping), `idx_ios_networkdevicename` (`/api/network/devices` aggregate).
- **L2Columns IsEditable/IncludeInProgress normalization is now ONE-TIME**, gated by
  `SyncMaintenanceFlags` key `l2columns_normalized_v1` — it used to rewrite those
  flags on every boot, clobbering cloud-pulled column config until the next pull.
  To force a re-run on a box: delete that flag row.
- The startup ALTER loop no longer silently swallows every error — non-"duplicate
  column name" failures log `[DB] MIGRATION-ERROR (startup continues)` with the
  failing statement. Grep logs for `MIGRATION-ERROR` when a box has schema oddities.
- **`Subsystems.CloudRemoved` column** (sync-convergence pass, same date): startup
  ALTER, additive, default 0. Set to 1 when a `caps=subsystem` delta entry reports
  the subsystem deleted on the cloud — flag only, NO local data is removed (mirrors
  `Ios.CloudRemoved`). `lib/cloud/delta-sync.ts` also carries a lazy PRAGMA-guarded
  ensure for DBs that predate this migration.

### Firmware baseline — per-MCM scoping (2026-07-21)

A **fourth** case worth its own entry, because it is BOTH kinds at once and the
order between them is load-bearing.

**CLOUD (manual, does NOT auto-run on deploy):**
`commissioning-cloud/scripts/add-firmware-subsystem-column.sql` — adds
`approved_firmware.subsystem_id` (NULL = fleet-wide default) and swaps the
fleet-wide unique key for one on `COALESCE(subsystem_id,-1)`.
GOTCHA: Prisma implements `@@unique` on Postgres as a bare UNIQUE **INDEX**, not a
table constraint, so `DROP CONSTRAINT IF EXISTS` silently no-ops. The script drops
**both** forms. Verify after applying:
```
\d approved_firmware   -- expect subsystem_id + approved_firmware_vendor_product_subsystem_key
```

**FIELD (automatic on startup):** `ApprovedFirmware` is REBUILT to carry
`SubsystemId` plus a per-scope unique index. Rows are **COPIED** across as
fleet-wide — the baseline must survive the upgrade because the tool is
offline-first. Verify after upgrading a tablet:
```
sqlite3 database.db "SELECT COUNT(*) FROM ApprovedFirmware;"
```
A drop to zero is a FAILED migration — re-pull and report it.
GOTCHA: SQLite REJECTS an expression inside an inline UNIQUE constraint
("expressions prohibited in PRIMARY KEY and UNIQUE"). It must be a separate
`CREATE UNIQUE INDEX`, placed AFTER the rebuild — inside the big
`initializeSchema()` exec it throws on old DBs and silently aborts every
statement after it in that block.

> **⚠ ORDER IS MANDATORY — GET IT WRONG AND THE FLEET LOSES FIRMWARE SCANNING.**
> A field tool WITHOUT the migration, talking to a cloud that HAS scoped rows,
> gets `POST /api/firmware/scan` → **HTTP 500** (old `UNIQUE(VendorId,ProductCode)`
> rejects two rows for one model; txn throws at `firmware-baseline-sync.ts`).
> Reproduced live. Correct order:
>   1. apply cloud SQL (inert on its own)
>   2. deploy cloud code (still inert — no scoped rows yet)
>   3. **ship the field release to every tablet**
>   4. ONLY THEN import scoped baselines per MCM
> Between 2 and 4 the fleet is safe: fleet-wide-only rows satisfy the old key.
> IO/L2 sync is unaffected either way — only firmware scanning breaks.

## 7. Maintenance

When you finish an onsite debug: add the new symptom→location row to §2, any new grep pattern, any new gotcha to §0/§4, and bump the "Last major update" line. Cross-link the detailed writeup in `.claude/.../memory/`.
