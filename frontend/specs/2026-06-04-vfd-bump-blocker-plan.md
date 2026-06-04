# VFD Bump Blocker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Capture VFD Bump Test failures as a Party→Description blocker, propagate them to the shared `Devices.Blocker*` columns (tracker mech dashboard + cloud), auto-clear on later success, and make `Valid_Map` durable right after the Identity step so mech gets F0/F1/F2 controls early.

**Spec:** `frontend/specs/2026-06-04-vfd-bump-blocker-design.md` — read it first; it contains the agreed decisions, vocabulary, lifecycle, and architecture diagram.

**Architecture:** New VFD-specific blocker vocabulary + dialog in the field tool; new `DeviceBlockerPendingSyncs` offline queue + drain in cloud-sync-service; new cloud endpoint `POST /api/sync/device-blocker` with conditional clear; per-flag assertion in the VFD validation writer.

**Tech stack:** Vite+React 18 client, Express 5 + better-sqlite3 server (`frontend/`), Next.js + Prisma (`commissioning-cloud/`, **separate git repo**), Vitest both sides.

**Repos & commits:** `frontend/` lives in the workspace repo (branch `main`); `commissioning-cloud/` is its own repo (branch `main`). **Subagents must NOT run `git commit`** — the working tree has unrelated WIP; the orchestrator commits at the end. Never revert or touch unrelated modified files (`pull-guard.ts`, `sync-failure-classification.ts`, `setup/page.tsx`, etc.) beyond additive edits where required.

---

## Shared contracts (all tasks must match these EXACTLY)

### Vocabulary (Task 1 defines; Tasks 3, 5 consume)

```ts
// frontend/lib/blockers.ts (appended; hand-mirrored to commissioning-cloud/lib/blockers.ts)
export const VFD_BLOCKER_PARTIES = ['Controls', 'Electrical', 'Mechanical'] as const
export type VfdBlockerParty = (typeof VFD_BLOCKER_PARTIES)[number]

export const VFD_BLOCKER_VOCAB: Record<VfdBlockerParty, string[]> = {
  Controls: ['VFD did not turn on', 'Other'],
  Electrical: [
    'VFD Faults Immediately',
    'VFD Faults after Running',
    "VFD turns on, motor doesn't move, motor fan doesn't move",
    'Other',
  ],
  Mechanical: [
    'VFD turns on, drive shaft moves, belt is slipping',
    "VFD turns on, drive shaft doesn't move",
    'VFD turns on, belt moves, makes harsh noise',
    'Other',
  ],
}

/**
 * Final stored description. 'Other' requires a non-empty comment and stores
 * "Other: <comment>". Non-Other descriptions store verbatim; comment ignored.
 */
export function buildVfdBlockerDescription(description: string, comment?: string): string
```

UI shows `Other` as **“Other — please specify”** but stores/matches `'Other'`.

### Local API route (Task 2 defines; Task 3 consumes)

`POST /api/vfd-commissioning/bump-blocker` body:

```jsonc
// set:
{ "subsystemId": 123, "deviceName": "UL9_9_VFD1", "op": "set",
  "blockerResponsibleParty": "Mechanical",
  "blockerDescription": "VFD turns on, drive shaft moves, belt is slipping",
  "updatedBy": "Nika Partenadze" }
// clear (conditional on cloud side):
{ "subsystemId": 123, "deviceName": "UL9_9_VFD1", "op": "clear",
  "expectedParty": "Mechanical",
  "expectedDescription": "VFD turns on, drive shaft moves, belt is slipping",
  "updatedBy": "Nika Partenadze" }
```

Response: `{ ok: true }` (enqueue is the success criterion; cloud push is async/best-effort
with background retry — same philosophy as IO result sync).

### Cloud endpoint (Task 5 defines; Task 2's drain calls it)

`POST {cloudUrl}/api/sync/device-blocker`, header `X-API-Key` (same auth as existing `/api/sync/*` routes — copy whatever `/api/sync/update` does). Body = the queue row:

```jsonc
{ "subsystemId": 123, "deviceName": "UL9_9_VFD1", "op": "set" | "clear",
  "blockerResponsibleParty": "...", "blockerDescription": "...",
  "expectedParty": "...", "expectedDescription": "...",
  "updatedBy": "...", "timestamp": "2026-06-04T12:00:00.000Z" }
```

Response: `{ ok: boolean, deviceId: number | null, cleared?: boolean, reason?: string }`.
HTTP 200 even when the device can't be resolved (`deviceId: null`, log it loudly) — an
unresolvable device must NOT poison the retry queue. Non-2xx only for auth/validation/server errors.

**Device resolution** (in this order):
1. `SELECT DISTINCT d."Id" FROM ios i JOIN "Devices" d ON d."Id" = i.device_id WHERE i.subsystemid = $subsystemId AND d."Name" = $deviceName` (via Prisma equivalents).
2. If exactly one → use it. If multiple → prefer `DeviceType = 'VFD'`; still ambiguous → take first, log warning.
3. If none → `{ ok: true, deviceId: null, reason: 'device-not-found' }` + console.warn.

**Writes** (in-lane: ONLY the two blocker columns, mirroring the existing comment in
`/api/sync/update` around its `Devices` blocker write):
- `op='set'` → `UPDATE Devices SET BlockerResponsibleParty=$party, BlockerDescription=$desc WHERE Id=$id`
- `op='clear'` → `updateMany WHERE Id=$id AND BlockerResponsibleParty=$expectedParty AND BlockerDescription=$expectedDescription` → set both to null. `cleared = count > 0`. A no-match clear is `ok: true, cleared: false` (someone re-triaged meanwhile — leave theirs alone).

### L2 cell format (Task 3 defines both sides of)

Column name: **`Bump Blocker`**. Value: `"<stamp> · <party> · <description>"` where
`<stamp>` is whatever initials+date convention Step 3 already uses for `Check Direction`
(reuse the same helper). Parse: `const parts = value.split(' · ')`; `party = parts[1]`,
`description = parts.slice(2).join(' · ')`. Empty/missing cell = not blocked.
The wizard must tolerate the column not existing on a sheet (skip stamp, log once, still
fire the sync op).

### Queue table (Task 2 defines)

```sql
CREATE TABLE IF NOT EXISTS DeviceBlockerPendingSyncs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  SubsystemId INTEGER NOT NULL,
  DeviceName TEXT NOT NULL,
  Op TEXT NOT NULL,                  -- 'set' | 'clear'
  BlockerResponsibleParty TEXT,
  BlockerDescription TEXT,
  ExpectedParty TEXT,
  ExpectedDescription TEXT,
  UpdatedBy TEXT,
  Timestamp TEXT,
  CreatedAt TEXT DEFAULT (datetime('now')),
  RetryCount INTEGER DEFAULT 0,
  LastError TEXT
);
CREATE INDEX IF NOT EXISTS idx_deviceblockersyncs_createdat ON DeviceBlockerPendingSyncs(CreatedAt);
```

---

## Task 1: VFD vocabulary + bump-fail dialog (frontend)

**Files:**
- Modify: `frontend/lib/blockers.ts` (append VFD exports per contract above; extend the
  hand-mirror header comment to mention the VFD vocab too)
- Create: `frontend/components/vfd-bump-fail-dialog.tsx`
- Test: `frontend/__tests__/vfd-blockers.test.ts`

- [x] Write failing Vitest tests for `buildVfdBlockerDescription`: non-Other returns the
      description verbatim; `'Other'` + comment returns `Other: <trimmed comment>`;
      `'Other'` + empty/whitespace comment throws. Also assert `VFD_BLOCKER_VOCAB` matches
      the spec lists exactly (guards against typos drifting from Kevin's memo).
- [x] Run `npm run test -- vfd-blockers` in `frontend/` — expect FAIL (not implemented).
- [x] Implement the exports in `frontend/lib/blockers.ts`. Run tests — expect PASS.
- [x] Create `VfdBumpFailDialog`, closely modeled on
      `frontend/components/fail-comment-dialog.tsx` (same Dialog/Select/Textarea/toast
      components and visual style), but: no Failure Reason field; parties =
      `VFD_BLOCKER_PARTIES`; descriptions cascade from `VFD_BLOCKER_VOCAB`; description
      option `'Other'` renders as “Other — please specify”; comment textarea is shown ONLY
      when Other is selected and is required (maxLength 500, same counter style). Props:

      ```ts
      interface VfdBumpFailDialogProps {
        open: boolean
        onOpenChange: (open: boolean) => void
        deviceName: string
        /** description is FINAL (Other already folded in via buildVfdBlockerDescription) */
        onSubmit: (party: VfdBlockerParty, description: string) => void
        onCancel: () => void
      }
      ```

      Submit button label: “Record blocker”, destructive variant, disabled until valid.
      Include a short amber hint that the blocker propagates to the installation tracker
      (mirror the unpass-mode hint wording in fail-comment-dialog.tsx).
- [x] `npm run lint` clean for touched files. Do NOT commit.

## Task 2: Offline queue + sync drain + local API route (frontend)

**Files:**
- Modify: `frontend/lib/db-sqlite.ts` (add table DDL per contract, next to the
  `L2PendingSyncs` DDL around line 461)
- Create: `frontend/lib/db/repositories/device-blocker-sync-repository.ts`
- Modify: `frontend/lib/cloud/cloud-sync-service.ts` (drain function + wire into the same
  background retry cycle that drains `L2PendingSyncs`; **file has unrelated uncommitted
  changes — additive edits only, follow the new failure-classification pattern already in
  the file/`sync-failure-classification.ts` so retries respect the retry-cap rules**)
- Create: `frontend/app/api/vfd-commissioning/bump-blocker/route.ts`
- Modify: `frontend/routes/index.ts` (mount it — copy how the sibling
  `vfd-commissioning/*` routes are mounted)
- Test: `frontend/__tests__/device-blocker-sync.test.ts`

- [x] Read `frontend/lib/db/repositories/pending-sync-repository.ts` and the L2 drain logic
      in `cloud-sync-service.ts` first; mirror their structure and naming.
- [x] Write failing tests against an in-memory/temp sqlite DB (follow the pattern used by
      existing repo tests, e.g. `__tests__/sync-retry-cap.test.ts`): enqueueSet inserts a
      row with Op='set'; enqueueClear stores expected pair; list returns oldest-first;
      delete removes; recordFailure bumps RetryCount + LastError.
- [x] Run tests — FAIL. Implement repository:

      ```ts
      export interface DeviceBlockerSyncRow { /* mirrors table columns, camelCase */ }
      export function enqueueDeviceBlockerSet(input: { subsystemId: number; deviceName: string;
        party: string; description: string; updatedBy?: string }): number
      export function enqueueDeviceBlockerClear(input: { subsystemId: number; deviceName: string;
        expectedParty: string; expectedDescription: string; updatedBy?: string }): number
      export function listDeviceBlockerSyncs(limit?: number): DeviceBlockerSyncRow[]
      export function deleteDeviceBlockerSync(id: number): void
      export function recordDeviceBlockerSyncFailure(id: number, error: string): void
      ```

      Timestamp = `new Date().toISOString()` at enqueue time. Run tests — PASS.
- [x] Add `pushDeviceBlockerSyncs()` to cloud-sync-service: drain rows oldest-first, POST
      each to `${remoteUrl}/api/sync/device-blocker` with the `X-API-Key` header (reuse the
      service's existing header/fetch helper); on 2xx delete row; on failure
      recordFailure + leave for retry, applying the same permanent/transient classification
      the L2 push uses. Export a `triggerDeviceBlockerPush()` (debounced instant push) and
      call `pushDeviceBlockerSyncs()` wherever the L2 queue is drained in the periodic loop.
- [x] Implement the Express route handler: validate body (`op` ∈ set|clear; required fields
      per op; party ∈ VFD_BLOCKER_PARTIES), enqueue via repository, fire
      `triggerDeviceBlockerPush()`, return `{ ok: true }`. Mount in `routes/index.ts`.
- [x] `npm run test` (full suite) + `npm run lint` — green. Do NOT commit.

## Task 3: Wizard Step 3 integration (frontend) — depends on Tasks 1+2

**Files:**
- Modify: `frontend/components/vfd-wizard-modal.tsx` (Step3Content, ~line 680-900, plus
  the L2 restore effect ~line 1307 and the Step 3 direction-commit handler ~line 750-790)
- Modify: whatever module implements `readL2CellsForDevice` (find it; add a `bumpBlocker`
  key reading the `Bump Blocker` column, same tolerant pattern as the other cells)
- Test: `frontend/__tests__/vfd-bump-blocker-cell.test.ts`

- [x] Extract two pure helpers (put them in `frontend/lib/vfd-bump-blocker.ts`):

      ```ts
      export function formatBumpBlockerCell(stamp: string, party: string, description: string): string
      export function parseBumpBlockerCell(value: string | null | undefined):
        { party: string; description: string } | null   // null when empty/unparseable
      ```

      TDD them first (round-trip; descriptions containing ' · ' survive via
      `parts.slice(2).join(' · ')`; null/''/garbage → null).
- [x] Step3Content UI: add a subtle destructive-outline button **“Bump didn’t work?”** next
      to the existing Bump button row, opening `VfdBumpFailDialog`. On submit:
      1. write the `Bump Blocker` L2 cell using the SAME write path + stamp helper Step 3
         already uses for `Check Direction` (find `handleSetPolarity`/the L2 write fetch in
         Step3Content and reuse it; skip gracefully with a single console.warn if the sheet
         has no such column);
      2. `POST /api/vfd-commissioning/bump-blocker` with op='set' (Task 2 contract;
         `updatedBy` = `userName` prop);
      3. set local state so the step shows a red banner:
         **“Blocked — assigned to {party}: {description}”** + muted sub-line
         “Re-bump to retry. Confirming direction (Set Normal / Invert) clears this blocker.”
         Style it like the existing red `Confirm failed` box at ~line 657.
- [x] Restore on open: in the `readL2CellsForDevice` effect, parse `cells.bumpBlocker` via
      `parseBumpBlockerCell` and seed the banner state (pass down to Step3Content as props,
      same way `initialPolarity` flows).
- [x] Auto-clear: in the direction-commit success path (where `Check Direction` is stamped
      and `Valid_Direction` written), if a bump blocker is active: clear the L2 cell (write
      empty string via the same L2 write path) AND `POST /api/vfd-commissioning/bump-blocker`
      with op='clear' + the expected pair from the active state; then clear the banner.
      Failures here are non-fatal (console.warn) — never block the polarity commit on it.
- [x] The blocker does NOT change `getStepStatus` / `canGoTo` gating — Step 3 progression
      stays PLC-bit driven (a blocked VFD simply can't progress because Valid_Direction
      never gets set; the banner is the operator-facing evidence).
- [x] `npm run test` + `npm run lint` green; `npm run build` compiles. Do NOT commit.

## Task 4: Per-flag validation writer (frontend) — independent

**Files:**
- Modify: `frontend/lib/vfd-validation-writer.ts` (`getValidatedDevices` query + the flag
  list construction in `batchWriteFlags`)
- Read first: `frontend/lib/vfd-polarity.ts` (`deviceFlagWrites`)
- Test: `frontend/__tests__/vfd-validation-writer-flags.test.ts`

- [x] Replace the single-cell query with a per-flag query returning one row per VFD device
      that has ANY progress:

      ```sql
      SELECT d.DeviceName AS deviceName, s.Name AS sheetName,
             MAX(CASE WHEN c.Name = 'Verify Identity'  AND cv.Value <> '' THEN 1 ELSE 0 END) AS hasIdentity,
             MAX(CASE WHEN c.Name = 'Motor HP (Field)' AND cv.Value <> '' THEN 1 ELSE 0 END) AS hasMotorHp,
             MAX(CASE WHEN c.Name = 'VFD HP (Field)'   AND cv.Value <> '' THEN 1 ELSE 0 END) AS hasVfdHp,
             MAX(CASE WHEN c.Name = 'Check Direction'  AND cv.Value <> '' THEN 1 ELSE 0 END) AS hasDirection,
             MAX(CASE WHEN c.Name = 'Polarity' THEN cv.Value END) AS polarityRaw
      FROM L2Devices d
      JOIN L2Sheets s   ON s.id = d.SheetId
      JOIN L2Columns c  ON c.SheetId = d.SheetId
      JOIN L2CellValues cv ON cv.DeviceId = d.id AND cv.ColumnId = c.id
      WHERE cv.Value IS NOT NULL AND cv.Value <> ''
        AND (UPPER(s.Name) LIKE '%VFD%' OR UPPER(s.Name) LIKE '%APF%')
      GROUP BY d.DeviceName, s.Name
      HAVING hasIdentity = 1 OR (hasMotorHp = 1 AND hasVfdHp = 1) OR hasDirection = 1
      ```

      (Verify exact L2 column names against the existing code/comments in `db-sqlite.ts`
      ~line 476 before relying on them.)
- [x] Build the per-device flag list: `Valid_Map` ⇐ hasIdentity; `Valid_HP` ⇐ hasMotorHp &&
      hasVfdHp; `Valid_Direction` + the polarity bits from
      `deviceFlagWrites(polarityRaw)` ⇐ hasDirection. **Assert-only semantics: only ever
      write 1s for earned flags; never write 0s for un-earned ones** (clearing happens via
      the explicit Invalidate pulses in the clear endpoint, not here). Keep ALL existing
      guards untouched: faulted-device skip, knownMissingTags cache, mass-failure circuit
      breaker, throttle, single summary log line.
- [x] Extract the "rows → TagHandle write list" mapping into a pure exported function
      (e.g. `flagsForDevice(row): Array<{ field: string; value: number }>`) and TDD it:
      identity-only → just Valid_Map; identity+HP → +Valid_HP; full → +Valid_Direction
      +polarity bits matching `deviceFlagWrites`'s current output; HP with only one cell
      filled → no Valid_HP. Update the doc comment at the top of the file (it currently
      says "only after Check Direction") and explain WHY (Kevin #2170: mech needs F0/F1/F2
      after identity; AOI keypad gating change is controls-side).
- [x] `npm run test` + `npm run lint` green. Do NOT commit.

## Task 5: Cloud endpoint + vocab mirror + L2 column script (commissioning-cloud repo)

**Files (all inside `commissioning-cloud/` — separate repo):**
- Modify: `lib/blockers.ts` (append the same VFD vocab block as frontend, with the
  hand-mirror comment)
- Create: `app/api/sync/device-blocker/route.ts`
- Create: `lib/device-blocker-resolution.ts` (pure-ish logic for resolve + conditional
  clear so it's unit-testable)
- Create: `scripts/add-bump-blocker-l2-column.ts` (or .sql — match how existing scripts in
  `scripts/` are written): adds an `Bump Blocker` column to every l2_sheets row whose name
  matches `%VFD%`/`%APF%` where no such column exists, appended after the last existing
  column position. NOT auto-run; deploy-time step.
- Test: `tests/device-blocker-resolution.test.ts` (mirror the mocking style of
  `tests/install-resolution.test.ts`)

- [x] Read `app/api/sync/update/route.ts` FIRST — copy its auth check verbatim, its Prisma
      usage style, and the in-lane `Devices` write pattern + comments (~line 367-396).
- [x] Implement per the **Cloud endpoint** contract in this plan's shared-contracts section
      (validation: op ∈ set|clear; party ∈ VFD_BLOCKER_PARTIES ∪ BLOCKER_PARTIES — accept
      both vocabularies so the endpoint stays future-proof; description non-empty for set;
      expected pair required for clear).
- [x] TDD `lib/device-blocker-resolution.ts`: resolution preference (single match; multiple
      → DeviceType 'VFD' preferred; none → null), set semantics, conditional-clear
      semantics (match → cleared true; mismatch → cleared false, no write).
- [x] Run the cloud repo's test + lint + build commands (check its package.json / CLAUDE.md).
      Do NOT commit.

## Task 6: Cross-repo verification + docs — depends on ALL above

**Files:**
- Modify: `docs/SYNC-CONTRACT.md` (workspace root) — new section "Device-level blocker sync
  (VFD bump test)" documenting the op payloads, conditional clear, resolution order, and
  the 200-on-unresolvable rule, copied from this plan's shared contracts.
- Modify: `frontend/specs/2026-06-04-vfd-bump-blocker-plan.md` — tick completed checkboxes.

- [x] `cd frontend && npm run test` — full suite green (expected: all pre-existing tests
      still pass + the new suites from Tasks 1-4).
- [x] `cd frontend && npm run lint && npm run build && npm run build:server` — clean.
- [x] In `commissioning-cloud/`: run its test suite + `next build` (or its documented build
      command) — clean.
- [x] Grep both repos to verify the vocab mirrors are byte-identical (the three party lists)
      and that payload field names match between `device-blocker-sync-repository.ts`,
      `cloud-sync-service.ts` push body, and the cloud route's parsed fields.
- [x] Verify wizard graceful degradation: confirm the L2-cell write path used in Task 3
      tolerates a missing `Bump Blocker` column (read the code path; if it throws, fix to
      warn-and-continue).
- [x] Update `docs/SYNC-CONTRACT.md`. Report a summary of any fixes made.

---

## Self-review notes

- Spec coverage: capture UI (T1+T3), propagation (T2+T5), mech dashboard (no-op, verified
  in design), F0/F1/F2 (T4 + AOI hand-off note in spec), Other-comment rule (T1),
  auto-clear with conditional semantics (T3+T5), deploy/provisioning (T5 script + spec
  deploy notes).
- Type consistency: payload field names are defined once in Shared Contracts; Tasks 2/3/5
  all reference it.
