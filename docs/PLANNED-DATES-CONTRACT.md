# Planned Dates on IOs — Cross-App Contract (2026-07-20)

Goal: PMs/PCs assign **planned dates** to IOs in the cloud (bulk + inline, modifiable),
filter open items by date every morning; dates flow **cloud → field** so electricians
can filter their IO list by date in the local tool. This is the date-based punchlist.

## Field definition

| Layer | Name | Type | Notes |
|---|---|---|---|
| Postgres `ios` | `planned_date` | `date NULL` | manual SQL, `ADD COLUMN IF NOT EXISTS` |
| Prisma `Io` | `plannedDate` | `DateTime? @map("planned_date") @db.Date` | mirrors existing `ecd` |
| Wire (all APIs + sync) | `plannedDate` | `"YYYY-MM-DD" \| null` | date-only ISO string |
| Local SQLite `Ios` | `PlannedDate` | `TEXT NULL` | stores the `YYYY-MM-DD` string verbatim |

- **Ownership: cloud-owned, field read-only.** No version bump on write (same class as
  `punchlistStatus`/`ecd`). Field applies it directly in pull/delta upserts — no
  local-authority `CASE WHEN` guard. Never enters `PendingSyncs`/outbound queue.
- Distinct from `ecd` (expected completion of a *failure fix*). `plannedDate` = when the
  work/test is *scheduled* to be done.

## Cloud (commissioning-cloud, branch `feat/planned-dates`)

1. Schema: add `plannedDate` to `Io`; re-bless `prisma/schema.prisma.sha256` same commit
   (schema-guard). SQL: `scripts/add-planned-date-column.sql` (idempotent, per
   `scripts/per-io-blockers.sql` ritual) — **must be applied to live commissioning-db
   BEFORE the deploy that ships the Prisma change**.
2. Single edit: `PATCH /api/punchlist/[id]` accepts/returns `plannedDate` (validated like
   `ecd`; `recordChange` + SSE already there).
3. Bulk assign: new `PATCH /api/admin/ios/planned-date` — `{ ids: number[], plannedDate:
   "YYYY-MM-DD" | null }`, transactional update + `recordChange` per id, SSE after commit.
4. Grid (`components/io-data-grid.tsx`): new "Planned" column (inline date editing), date
   bucket filter (No date / Overdue / Today / This week / Next week / Later), row
   checkboxes + select-all-filtered + bulk "Set planned date" toolbar.
5. Server select+map: `app/project/[id]/detail/page.tsx`.
6. **Sync serializers (both, or the field never sees it):**
   `app/api/sync/subsystem/[id]/changes/route.ts` `serialize()` and
   `app/api/sync/subsystem/[id]/route.ts` full-pull serializer → emit
   `plannedDate: "YYYY-MM-DD" | null`.

## Local field tool (commissioning-local/frontend)

1. `lib/db-sqlite.ts`: migration `ALTER TABLE Ios ADD COLUMN PlannedDate TEXT`;
   `interface Io` + `ioToApi()` (`plannedDate`).
2. `lib/cloud/pull-core.ts`: `CloudIo`, `UPSERT_IO_SQL` (cols/VALUES/SET — direct set),
   param builder.
3. `lib/cloud/delta-sync.ts`: `DeltaIo`, **both** upsert stmts, `ioToParams`.
4. Types: `app/commissioning/[id]/page-helpers.ts` + `components/enhanced-io-data-grid/types.ts`.
5. Grid (`enhanced-io-data-grid.tsx`): "Planned" sortable column + planned-date filter
   (All / Overdue / Today / This week / Has date / No date + specific date), predicate in
   `filteredIos` memo. Field-side editing: none (read-only, comes from cloud).

## Rollout order

1. Apply SQL on live commissioning-db (dockerhost, with pg_dump backup).
2. Deploy cloud (merge `feat/planned-dates` → main, push GitLab → auto-deploy).
3. Field tool: ships in next tablet release; older field tools ignore the unknown key
   (additive contract — safe).
