# L2 Context

## Goal

L2 Functional Validation is the project-level validation matrix for field devices.

The target workflow is:

1. Admin imports one Excel workbook into `commissioning-cloud`.
2. That workbook creates the initial L2 sheet structure and device list.
3. Admins define the actual validation columns in the cloud UI.
4. The local commissioning tool pulls that L2 structure from cloud.
5. Technicians fill in live L2 values locally.
6. Local changes sync back to cloud without breaking offline behavior or live updates.

This feature exists across both apps:

- `commissioning-cloud/` owns L2 template definition, sheet structure, admin editing, and central sync endpoints.
- `frontend/` owns local rendering, local editing, offline persistence, push queueing, and pull/apply from cloud.

## Source Of Truth

The current Excel source of truth is:

- [CDW5_Generic_Functional_Validation (7).xlsx](C:/Users/nika.fartenadze/Desktop/commissioning-local/CDW5_Generic_Functional_Validation%20(7).xlsx)

Rules for that workbook:

- Each device type has its own sheet.
- The sheet itself is the initial truth for device rows.
- The first row is the header row.
- The first column is the device name.
- `MCM` and `Subsystem` are recognized specially when present.
- Other workbook columns are imported as fixed system metadata columns.
- For certain devices, workbook metadata like VFD horsepower is preserved as fixed readonly data.

Important process rule:

- Excel import is for initial seeding of L2 devices and fixed workbook metadata.
- Ongoing editable validation columns are created in the cloud app, not in Excel.

## Intended UX

Admins should manage L2 structure in the same mental model as the L2 sheet itself, not through detached cards.

The intended UX is:

- On the actual project L2 page in `commissioning-cloud`, admins can switch on `Edit Mode`.
- In `Edit Mode`, admins can add, edit, and delete custom columns directly from the sheet view.
- Column configuration includes:
  - column name
  - input type
  - whether it counts toward progress
  - optional description
- Normal users should see the same sheet without structural editing controls.

The local tool should present the same sheet data naturally for field entry, but it should not own the structural definition of L2 columns.

## What Is Fixed vs Dynamic

Fixed from workbook import:

- sheet names
- device names
- `MCM`
- `Subsystem`
- workbook metadata columns such as device-specific readonly fields

Defined dynamically in cloud:

- custom validation columns
- custom column names
- custom column input types
- whether a column counts toward progress

Supported dynamic input types:

- `pass_fail`
- `number`
- `text`
- `readonly`

## Current Implementation

### Cloud App

Relevant files:

- [commissioning-cloud/app/api/admin/l2/import/execute/route.ts](C:/Users/nika.fartenadze/Desktop/commissioning-local/commissioning-cloud/app/api/admin/l2/import/execute/route.ts)
- [commissioning-cloud/app/api/admin/l2/import/preview/route.ts](C:/Users/nika.fartenadze/Desktop/commissioning-local/commissioning-cloud/app/api/admin/l2/import/preview/route.ts)
- [commissioning-cloud/app/api/admin/l2/columns/route.ts](C:/Users/nika.fartenadze/Desktop/commissioning-local/commissioning-cloud/app/api/admin/l2/columns/route.ts)
- [commissioning-cloud/app/api/admin/l2/columns/[columnId]/route.ts](<C:/Users/nika.fartenadze/Desktop/commissioning-local/commissioning-cloud/app/api/admin/l2/columns/[columnId]/route.ts>)
- [commissioning-cloud/components/l2-data-viewer.tsx](C:/Users/nika.fartenadze/Desktop/commissioning-local/commissioning-cloud/components/l2-data-viewer.tsx)
- [commissioning-cloud/lib/l2.ts](C:/Users/nika.fartenadze/Desktop/commissioning-local/commissioning-cloud/lib/l2.ts)
- [commissioning-cloud/prisma/schema.prisma](C:/Users/nika.fartenadze/Desktop/commissioning-local/commissioning-cloud/prisma/schema.prisma)

Cloud now does the following:

- imports the new workbook format sheet-by-sheet
- creates one L2 template per project
- creates one L2 sheet per workbook sheet
- imports workbook-owned readonly/system columns
- imports L2 devices per sheet
- preserves cloud-defined custom columns
- exposes column CRUD for admins
- exposes L2 summary data for dashboards and overview

Admin editing is available directly on the project L2 page through `Edit Mode`.

### Local Tool

Relevant files:

- [frontend/app/api/cloud/pull/route.ts](C:/Users/nika.fartenadze/Desktop/commissioning-local/frontend/app/api/cloud/pull/route.ts)
- [frontend/app/api/cloud/pull-l2/route.ts](C:/Users/nika.fartenadze/Desktop/commissioning-local/frontend/app/api/cloud/pull-l2/route.ts)
- [frontend/app/api/l2/cell/route.ts](C:/Users/nika.fartenadze/Desktop/commissioning-local/frontend/app/api/l2/cell/route.ts)
- [frontend/app/api/l2/overview/route.ts](C:/Users/nika.fartenadze/Desktop/commissioning-local/frontend/app/api/l2/overview/route.ts)
- [frontend/components/l2-validation-view.tsx](C:/Users/nika.fartenadze/Desktop/commissioning-local/frontend/components/l2-validation-view.tsx)
- [frontend/components/l2-sheet-grid.tsx](C:/Users/nika.fartenadze/Desktop/commissioning-local/frontend/components/l2-sheet-grid.tsx)
- [frontend/components/l2-overview-matrix.tsx](C:/Users/nika.fartenadze/Desktop/commissioning-local/frontend/components/l2-overview-matrix.tsx)
- [frontend/lib/db-sqlite.ts](C:/Users/nika.fartenadze/Desktop/commissioning-local/frontend/lib/db-sqlite.ts)

Local now does the following:

- pulls dynamic L2 sheets and columns from cloud
- stores them in local SQLite
- renders dynamic columns instead of hardcoded `check/data/notes/readonly`
- saves field edits locally
- queues L2 updates for sync
- pushes L2 updates back to cloud
- applies live cloud sync updates

## What Has Been Done

Implemented in this feature pass:

- switched L2 workbook parsing to the new Excel format
- treated each workbook sheet as a device-type sheet
- preserved workbook readonly metadata as system columns
- added cloud-side custom column management
- moved admin column editing into the real L2 sheet view
- added explicit admin `Edit Mode`
- updated local tool to support dynamic L2 columns
- changed progress logic to follow `includeInProgress`
- kept local save/sync/live-update flow intact
- fixed a hydration issue in the cloud project dashboard
- fixed the original import failure caused by long Prisma interactive transactions
- optimized import away from row-by-row `upsert` patterns

## Import Performance Direction

The old implementation had unacceptable N+1 behavior:

- per-device updates
- per-cell upserts
- per-column reorder updates
- per-device progress updates

The current import path was changed to a bulk-oriented model:

- workbook-owned system columns are replaced in batches
- sheet devices are replaced in batches
- workbook cell values are inserted with `createMany` in chunks
- column reorder uses one set-based SQL update
- progress recalculation uses set-based SQL

This is intentionally optimized for the real workflow:

- Excel seeds the structure once
- cloud defines custom editable validation columns
- local field entry is ongoing

## Constraints And Assumptions

- The three apps live side by side in this workspace, but each app still belongs to its own Git repo.
- `commissioning-cloud` and `frontend` must stay compatible on L2 payload shape.
- The local tool must remain offline-first.
- Live sync and queued sync must not be broken by structural L2 changes.
- Workbook-owned columns should remain readonly/system columns.
- Admin-defined columns should remain editable and cloud-controlled.

## Risk Areas

Areas to watch when changing L2 further:

- import speed on very large workbooks
- preserving custom columns during workbook replacement
- progress calculations when column definitions change
- overview behavior when a sheet has unusual fixed columns
- sync compatibility between cloud Postgres data and local SQLite data
- SSE/live update behavior after structure changes

## Practical Rule

When working on L2:

1. Treat the workbook as the seed for sheets, devices, and fixed metadata.
2. Treat `commissioning-cloud` as the owner of dynamic L2 structure.
3. Treat `frontend` as the owner of local editing and offline sync behavior.
4. Verify overview, progress, and sync together, not in isolation.
