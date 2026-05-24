# Spec: Trustworthy cloud-controlled updates (real status feedback)

Status: **TODO** — written 2026-05-24 as a handoff for a fresh-context session.
Cross-app (commissioning-local + commissioning-cloud). Follow `/deploy-comm`
for the cloud deploy and the auto-update release recipe in the
`project-auto-update-channel` memory for the local build.

## Problem (observed in the field, 2026-05-24)

Admin clicked **Push update** in the cloud fleet UI. Cloud showed the command
result **`done`**, but the tablet was still on **v2.39.0** (not v2.39.1). The
local tool's own in-app updater *did* detect v2.39.1, so the manifest + binary
are reachable — the cloud-push path just silently didn't land it, and the UI
lied about it.

Root cause: the local command handler reports `done` **the instant it spawns
the detached updater**, not when the install actually finishes.
- `commissioning-local/frontend/lib/heartbeat/command-handler.ts`, `case 'update'`:
  spawns `install-update.ps1` with `{ detached: true, stdio: 'ignore' }` and
  immediately `enqueueResult({ status: 'done', ... })` (see the comment block
  "report 'done' once the pipeline has been *started*"). It also returns `done`
  without doing anything when the pushed version <= current (downgrade guard).
- So `LaptopCommand.status = done` means "updater launched", NOT "version changed".
- The real per-step outcome IS written by `install-update.ps1` via `Write-State`
  to `update-status.json` (`resolveUpdateStatePath()` →
  `<storage root>/update-status.json`, i.e. `C:\ProgramData\CommissioningTool\update-status.json`
  in installer mode). The cloud never sees it.

Note: the heartbeat ALREADY reports the true running `version`
(`heartbeat-service.ts` → `getCurrentAppVersion()`), and the cloud already
stores it on `ToolInstance.version`. So the cloud has the truth available — the
fix is to (a) also ship the update-status blob, and (b) stop treating the
command `done` as success in the UI.

## Goal

Fleet UI shows the REAL update lifecycle per tablet:
`pending → sent → downloading → installing → restarting → success | error`
with the error message surfaced, and "update complete" is judged by
**heartbeat-reported `version == target` AND `updateStatus == success`**, never
by the command-result `done`.

## Changes

### Local tool (`commissioning-local/frontend`)

1. **Ship the update status on every heartbeat.**
   - `lib/heartbeat/heartbeat-service.ts`:
     - Extend `HeartbeatPayload` with
       `updateStatus?: { status: string; message?: string; version?: string; startedAt?: string; completedAt?: string } | null`.
     - In `buildHeartbeatPayload()`, read `resolveUpdateStatePath()` (import from
       `@/lib/storage-paths`); if the file exists and parses, include it as
       `updateStatus`, else `null`. Wrap in try/catch — never throw from the builder.
   - Keep it small; this is just surfacing the file the updater already writes.

2. **Reset stale status when a new update launches** so the heartbeat doesn't
   report a previous run's `success`/`error` while the new one runs.
   - `lib/heartbeat/command-handler.ts`, `case 'update'`: right before/after
     spawning, write a fresh `{ status: 'launching', message: 'update command received', version: <target> }`
     to `resolveUpdateStatePath()` (or have it write `checking`). `install-update.ps1`
     overwrites it through its own `Write-State` calls immediately after.
   - Leave the command result as a quick ack, but change the string from a bare
     `done` to something honest, e.g. result text
     `update launched v<cur> -> v<target>; track via heartbeat`. (Status stays
     `done` since the enum is pending|sent|done|failed and the *command* did
     succeed in launching — the UI must not equate this with update success.)

3. No installer/updater logic changes here — v2.39.1 already hardened
   `install-update.ps1` (node-exit wait, Defender exclusion, post-install DLL
   verify + retry, real failure reporting). This spec is purely the
   feedback/visibility loop.

### Cloud (`commissioning-cloud`)

1. **Schema** (`prisma/schema.prisma`, `model ToolInstance`) — additive columns:
   ```
   updateStatus        String?   @map("update_status") @db.VarChar(32)
   updateMessage       String?   @map("update_message") @db.Text
   updateTargetVersion String?   @map("update_target_version") @db.VarChar(32)
   updateUpdatedAt     DateTime? @map("update_updated_at") @db.Timestamptz(6)
   ```
   Apply with the `/deploy-comm` additive-DDL path (psql one-off on dockerhost,
   NEVER `prisma db push` against the shared DB). Then `npx prisma generate`.

2. **Heartbeat receiver** (`app/api/sync/heartbeat/route.ts`):
   - Add `updateStatus` to the zod schema (an optional nullable object with
     `status`, `message?`, `version?`, `startedAt?`, `completedAt?`).
   - On the `prisma.toolInstance.upsert`, map it into the new columns
     (`updateStatus`, `updateMessage`, `updateTargetVersion = updateStatus.version`,
     `updateUpdatedAt = now()`), in both `create` and `update` branches.

3. **Fleet UI** (`components/tool-instances-viewer.tsx`, InstanceDetailDialog):
   - Render the live update state from the instance's `updateStatus` /
     `updateMessage` (badge: downloading/installing/restarting = amber spinner,
     `success` = green, `error` = red with the message shown).
   - After clicking **Push update**, show "launched — awaiting tablet…" and let
     the existing ~3s poll refresh `updateStatus` + `version`. Treat the update
     as **complete only when** `version === targetVersion && updateStatus === 'success'`,
     and as **failed** when `updateStatus === 'error'` (show `updateMessage`).
   - Do NOT show "done" from the `LaptopCommand.result` as update success — that
     string is just the launch ack. (Keep showing it in the raw Commands panel
     if useful, but relabel so it's not mistaken for completion.)
   - Version chip already uses heartbeat `version` — keep.

4. Whatever endpoint feeds the fleet UI (the instances list/detail API) must
   `select` the new columns so they reach the client.

## Verification

- Push update to a tablet on v2.39.1 (so the hardened updater runs). Watch the
  dialog go `launching → downloading → installing → restarting → success`, and
  the version chip flip to the target only on success.
- Force a failure (e.g. point at a bad installerUrl) and confirm the dialog
  shows `error` + the message, and the chip does NOT flip.

## Immediate open item (separate from this feature)

The tablet currently stuck on v2.39.0 needs its
`C:\ProgramData\CommissioningTool\update-status.json` read to learn why the
detached install failed (leading hypotheses: locked-DLL skip or AV quarantine
during the old-updater-driven hop into v2.39.1). The sure fix is a **manual run
of `CommissioningTool-Setup-v2.39.1.exe`** on it (v2.39.1's installer adds the
Defender exclusion and verifies the DLL). Check Smart App Control first:
`Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -Name VerifiedAndReputablePolicyState`
(`1` = SAC enforced → exclusion can't help, needs signing or SAC off).

## Related
- `project-auto-update-channel` memory — release recipe + the v2.39.0/v2.39.1
  failure-mode writeup.
- `reference-dockerhost` memory — deploy target.
