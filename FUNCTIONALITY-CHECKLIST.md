# Commissioning Tool — Functionality Checklist

**Purpose:** the authoritative list of what the field tool (`frontend/`) and its cloud sync **must** do.
Use it as a pre-release regression checklist: every item is a testable assertion. Nothing here should
ever break silently. Grounded in the actual API routes (`app/api/**/route.ts`), pages, and components.

**Legend:**
- `[ ]` — verify before any release.
- ⚠️ **GUARD** — tied to a real field incident. Breaking these = data loss / belt damage / work stoppage. Highest priority.
- 🧪 **Battle** — covered by the automated battle rig (`battle/`); see the invariant in brackets.

Last updated: 2026-06-19 (v2.42.2).

---

## 1. Setup & Configuration
*Pages: `setup`, `settings/mcms` · Components: `plc-config-dialog`, `subsystem-config-dialog`, `subsystem-dialog` · API: `configuration*`, `subsystems/list`*

- [ ] First-run setup collects: cloud URL, API password, subsystem, PLC IP + routing path; persists to `config.json` beside the active DB.
- [ ] `config.json` resolves beside the SQLite DB (portable) or in `C:\ProgramData\CommissioningTool\` (installer); `CONFIG_PATH` overrides.
- [ ] Config file is **watched** — external edits reload at runtime without a restart.
- [ ] Switching subsystem (`configuration/switch-subsystem`) re-scopes the whole UI to that subsystem.
- [ ] An unconfigured landing (`/commissioning/_`) auto-redirects to the configured subsystem, or opens the config dialog.
- [ ] Pulling IOs for a subsystem updates the route + config to that subsystem.

## 2. Authentication & Users
*Components: `login-screen`, `change-pin-gate`, `user-menu`, `name-prompt` · API: `auth/*`, `users/*`*

- [ ] Login (PIN/JWT) and logout work; `auth/mode` reports whether auth is enabled.
- [ ] Operator identity is captured (name) and attributed to test results (`testedBy`).
- [ ] Admin: create/list users, reset PIN, toggle active (`users/[id]/*`).
- [ ] Role gating: testers can select + test; config endpoints respect admin where enabled.
- [ ] When auth is disabled, the app still functions (anon admin) — no hard block.

## 3. PLC Connection & Live Tags
*Components: `plc-toolbar`, `connection-guard`, `connection-lost-overlay`, `connection-slow-banner` · API: `plc/connect|disconnect|status|tags|test-connection|toggle-testing`*

- [ ] Connect to a PLC over Ethernet/IP via the configured IP + routing path (libplctag).
- [ ] ⚠️ **GUARD** Routing path is correct for the topology — Ethernet-out port `18`/`19` (A/B), **not** `2` (see CDW5 multi-VLAN paths).
- [ ] Live tag states stream continuously; UI reflects them via WebSocket (`:3000/ws`).
- [ ] Auto-reconnect on drop (5 s retry); "reconnecting" + "slow" banners show.
- [ ] `toggle-testing` starts/stops the tag reader; status reflects testing/connected/reconnecting.
- [ ] ⚠️ **GUARD** No PLC **handle leak** — long sessions don't degrade into a "must restart" state (handle-leak audit, v2.38.1).
- [ ] ⚠️ **GUARD** `libplctag` loads on fresh Win11 laptops — `vcruntime140.dll` bundled / VC++ redist installed (the "os error 126" fix).

## 4. I/O Testing Grid
*Components: `enhanced-io-data-grid`, `io-data-grid`, `quick-filters`, `filter-panel`, `filter-chips` · API: `ios`, `ios/[id]*`, `ios/stats`, `ios/assign*`, `ios/populate-devices`*

- [ ] Grid loads IOs **scoped to the route subsystem** (`?subsystemId=<paramId>`), with live tag values.
- [ ] Mark Pass / Fail / Reset per IO (`ios/[id]/test`, `/reset`, `/state`); writes are local-first.
- [ ] Fire output (`ios/[id]/fire-output`) energizes an output safely; respects safety state.
- [ ] ⚠️ **GUARD** **SPARE** IOs are never auto-Passed/touched; a SPARE only goes Failed on unexpected live state (wrong wiring).
- [ ] "Addressed" status for failed-IO feedback loop is settable (`ios/[id]/addressed`).
- [ ] IO dependencies enforced where defined (`ios/[id]/dependencies`).
- [ ] Filters (quick filters, discipline, status, search) and stats badges reflect the current subsystem only.
- [ ] Install/NET columns populate from resolved install data; NET is live-only (gray when no field tool connected).
- [ ] Counts exclude SPARE from pass/fail/not-tested/not-installed totals.

## 5. Pass/Fail Workflow, Comments & Discipline
*Components: `fail-comment-dialog`, `value-change-dialog` · API: `plc/mark-passed|mark-failed`, `ios/[id]/punchlist`, `punchlists`*

- [ ] Failing an IO prompts for a comment; unpass (Passed→Failed) routes to the shared Devices row in cloud.
- [ ] Discipline/Party-Responsible captured on Fail and synced (punchlist discipline).
- [ ] Punchlist items per IO and per subsystem load + sync.
- [ ] Both values preserved in TestHistory audit trail on last-write-wins UI conflicts.

## 6. Functional Validation (Level 2 / L2)
*Components: `fv-validation-view`, `fv-sheet-grid`, `fv-overview-matrix` · API: `l2`, `l2/cell`, `l2/overview`, `cloud/pull-l2`, `cloud/sync-l2*`*

- [ ] FV view loads L2 sheets/columns (global templates) + devices/cell values.
- [ ] ⚠️ **GUARD** 🧪 **Battle [I10]** L2 data is **scoped per MCM** — opening MCM01 shows MCM01's FV data, never another MCM's. (`?subsystemId=<route>`; the v2.42.1 per-MCM wiring fix.)
- [ ] Cell edits write local-first and sync (`l2/cell`, `cloud/sync-l2`); offline edits queue.
- [ ] `cloud/pull-l2` reconciles per-subsystem (scoped replace), never wiping other MCMs' L2.
- [ ] FV overview matrix summarizes per-device/per-column completion.

## 7. VFD Commissioning Wizard
*Components: `vfd-commissioning-view`, `vfd-wizard-modal`, `vfd-bump-fail-dialog` · API: `vfd-commissioning/*`*

- [ ] Wizard opens/closes per device (`wizard-open`, `wizard-close`); reads live VFD tags (`read-tags`).
- [ ] Verify Identity + Check Direction steps trust L2 stamps (no false re-ask on a CIP-saturated controller — the VFD re-verify fix).
- [ ] ⚠️ **GUARD** **Polarity / map / hp / direction tags are written back to the PLC** on completion (`write-tag`, `write-tags-batch`, `write-l2-cells`). If writeback stops, **belts reverse and VFDs break** — this is the single most safety-critical path.
- [ ] ⚠️ **GUARD** 🧪 **Battle [I3]** After a PLC program download (or reconnect), the writeback **restores** automatically — verified by `VfdValidationWriter` re-sync (e.g. "209 written").
- [ ] ⚠️ **GUARD** The writeback is **async/non-blocking** (trigger-driven read-compare-write via `plc_tag_get_bit`) — it must never block the event loop and freeze the server (the MCM02 freeze, v2.40.2; never truthiness-compare `get_int8`).
- [ ] "Controls Verified" flag sets + syncs (`controls-verified`).
- [ ] Bump-test blocker captured as device-level `Devices.Blocker*` + synced (`bump-blocker`); per-flag `Valid_*` writer.
- [ ] `test-write` / `clear` paths work without corrupting device state.

## 8. Network Diagnostics & Topology
*Components: `network-diagnostics-view`, `network-topology-view`, `ring-health-badge`, `network-status-breadcrumbs` · API: `network/*`*

- [ ] ⚠️ **GUARD** Diagnostics scope to the **route subsystem** (per-MCM), not the singleton config (v2.42.1 wiring fix).
- [ ] Device/module/FIOM-port status reads live (`network/devices|modules|fiom-ports|status`).
- [ ] Ring health + chain status compute per MCM; faulted devices flagged and feed IO-grid blocking.
- [ ] Topology view renders the network graph for the selected MCM.
- [ ] Firmware/compliance folded into the diagnostics view (controller card + device chips).

## 9. E-Stop Checks
*Components: `estop-check-view` · API: `estop/check`, `estop/status`*

- [ ] ⚠️ **GUARD** E-Stop view scopes to the route subsystem (per-MCM wiring fix).
- [ ] Per-zone E-Stop check tag values read live; ok/failed/no-data counts summarized.

## 10. Safety I/O
*Components: `safety-io-view`, `fire-output-dialog` · API: `safety/zones|status|fire|bypass|outputs`*

- [ ] Safety zones + outputs load and read live; per-MCM scoped.
- [ ] Fire/bypass safety outputs gated appropriately; never fire when unsafe.

## 11. Firmware Compliance
*API: `firmware`, `firmware/baseline`, `firmware/scan`, `firmware/controller` · `device/identity`*

- [ ] Reads controller firmware via CIP Identity (`@raw`) + device firmware from diagnostics snapshots (zero extra CIP load).
- [ ] Compares against the cloud-synced baseline; verdicts (compliant / below-min / unreachable) per device.
- [ ] ⚠️ **GUARD** On central/remote mode, firmware is sourced per-MCM (registry snapshots), not the singleton — every MCM's devices appear.

## 12. Guided Mode / Task Pool
*Page: `commissioning/[id]/guided` · API: `guided/*`*

- [ ] Guided runner scopes to the route subsystem (`parseInt(params.id)`).
- [ ] Priority-driven Phase→Segment→Task→Step engine drives the operator through checks.
- [ ] PLC auto-detect IO checks (client-side); skip-with-reason supported (`guided/tasks/skip`).
- [ ] Complete/reset task + step (`guided/tasks/complete`, `guided/reset-subsystem`); device clear (`guided/clear`).
- [ ] Classic device-walk view available via `?classic=1`; "Exit" returns to the full tool (no functionality lost).

## 13. Controller Management / Program Download
*Components: `controller-console` · API: `controller-management/*`*

- [ ] Controller health, mode, comm-path, status read.
- [ ] Program download job lifecycle (`download`, `job`, `status`) behaves as designed; projects listed.
- [ ] (Vendor-lockout research path — treat as experimental; do not regress the safe read-only status paths.)

## 14. Change Requests
*Components: `change-requests-panel`, `change-request-dialog` · API: `change-requests`, `change-requests/[id]`*

- [ ] Raise / list / resolve change requests; they sync to cloud.

## 15. History & Audit
*Components: `test-history-dialog`, `all-test-history-dialog`, `test-results-chart`, `date-range-filter` · API: `history`, `history/[ioId]`, `history/export`, `project/[id]/history`*

- [ ] Per-IO and full test history viewable; date-range filterable; exportable (CSV).
- [ ] ⚠️ **GUARD** History is the **audit trail** — both sides of any last-write-wins conflict are preserved, never overwritten.

## 16. Cloud Sync — Push (local → cloud)
*API: `cloud/sync`, `cloud/auto-sync`, `sync/update`, `sync/subsystem/[id]`, `sync/health`*

- [ ] ⚠️ **GUARD** 🧪 **Battle [I4]** Every result/comment/reset pushes to cloud; **nothing is silently dropped**. `suspect_silent_drops` must be 0.
- [ ] ⚠️ **GUARD** HTTP 429 (rate-limit) is treated as **transient** (retry, no strike) — never classed permanent and deleted (B1 / MCM11 class, fixed v2.40.3).
- [ ] ⚠️ **GUARD** Retry-cap **parks** rows (`DeadLettered=1`) for attention — it never silently deletes queued work.
- [ ] Local SQLite is the sole authority for results; cloud is a read-only receiver.
- [ ] Background retry every ~30 s moves pending work when connectivity returns.

## 17. Cloud Sync — Pull (cloud → local)
*API: `cloud/pull`, `cloud/pull-l2`, `cloud/pull-estop`, `cloud/pull-network`, `cloud/pull-mcm-diagram`, `cloud/pull-roadmap`, `cloud/sync-pull`, `mcm/[id]/pull`, `mcm/pull-all`*

- [ ] ⚠️ **GUARD** 🧪 **Battle [I4]** A pull **never wipes local field results** — pre-pull DB backup is taken first (MCM08 818-result wipe class).
- [ ] ⚠️ **GUARD** No-op pulls are **skipped** (hash short-circuit) — no DELETE+reinsert churn (MCM11 no-op pull class).
- [ ] Auto-pull is deferred while there's **active** local work (`PendingSyncs WHERE DeadLettered=0`); parked rows must NOT block pulls (v2.40.4 regression, fixed).
- [ ] Pull reconciles per-subsystem scoped; legacy NULL-subsystem rows handled without leaking across MCMs.

## 18. Offline-First & Resilience
*Components: `connection-lost-overlay`, `connection-slow-banner`*

- [ ] ⚠️ **GUARD** 🧪 **Battle [I4]** Work continues fully **offline** (local-first); results queue locally.
- [ ] ⚠️ **GUARD** 🧪 **Battle [I4]** When internet returns — **hours, days, or a week later** — the entire queue flushes to cloud with zero loss (`pending_queue_at_end → 0`).
- [ ] Reconnection (PLC, cloud, or app restart) causes **no data loss and no work interruption**.
- [ ] 🧪 **Battle [I1/I5]** Server stays responsive and stable under load + chaos (no freeze, no crash loop).

## 19. Database Backups & Recovery
*API: `backups`, `backups/[filename]`, `backups/[filename]/sync`*

- [ ] Automatic DB backup **before any manual Pull IOs** (and pre-upgrade by the installer).
- [ ] ⚠️ **GUARD** 🧪 **Battle [I9]** Backups are **bounded** — pruning keeps ≤ `BACKUP_RETENTION_KEEP` (prod default 300) so they never balloon to GBs (MCM11 4 GB incident). Verified actively deleting.
- [ ] Backups are listable + restorable; a backup can be re-synced (`backups/[filename]/sync`).
- [ ] WAL mode + durability pragmas — crash-safe.

## 20. Central Server / Multi-MCM (PLC_MODE=remote)
*Pages: `mcm`, `settings/mcms` · API: `mcm`, `mcm/[subsystemId]/*`, `mcm/connect-all`, `mcm/disconnect-all`, `mcm/pull-all`, `mcm/import-from-cloud`, `mcm/cloud-config`*

- [ ] ⚠️ **GUARD** 🧪 **Battle [I10]** **10+ MCMs connect concurrently**, each with its own scoped IOs / L2 / network — **zero cross-MCM data leak** (`unscoped_*` = 0). Validated at 10 MCMs.
- [ ] ⚠️ **GUARD** Per-MCM connect / disconnect / status / pull are **routed by `subsystemId`** (registry), never the singleton (`lib/mcm-registry.ts`).
- [ ] ⚠️ **GUARD** The UI feeds every per-MCM view the **route subsystem**, not the mutable `plcConfig.subsystemId` (v2.42.1) — applies to FV, network, e-stop, safety, punchlists, stats, toolbar links.
- [ ] Split deployment: app runs `PLC_MODE=remote`; the `plc-gateway` process owns PLC connections + broadcasts events (tag changes, `McmReconnected`) to the app's `:3102` seam.
- [ ] ⚠️ **GUARD** 🧪 **Battle [I8]** The live SSE channel authorizes the field tool's `X-API-Key` (scoped) — no 401/403 → portal "Red" (MCM11 SSE incident).
- [ ] `connect-all` / `disconnect-all` / `pull-all` operate across the whole registry without blocking the event loop.

## 21. Maps / Diagram
*Pages: `diagram` · Components: `mcm-diagram-view` · API: `maps/subsystem/[id]`, `mcm-diagram/[mcm]`, `cloud/pull-mcm-diagram`*

- [ ] Subsystem/MCM diagram renders and pulls from cloud; per-MCM scoped.

## 22. Roadmap / Progress
*Components: `project-dashboard`, `project-list*` · API: `roadmap`, `cloud/pull-roadmap`, `project/[id]/*`*

- [ ] Project dashboard + list load; roadmap/progress reflects current state per project/MCM.

## 23. Real-time / WebSocket
- [ ] Tag-state events broadcast PLC→`:3102`→`:3000/ws`→browser; UI updates live.
- [ ] On a per-MCM page, the client subscribes server-side to **only that MCM's** broadcasts (avoids cross-MCM WS flood).
- [ ] `connection-guard` / overlay / banners reflect WS + cloud connectivity accurately.

## 24. Update Channel
*API: `update/status`, `update/install` · plus cloud-pushed auto-update*

- [ ] Tool reports its version + update status via heartbeat; cloud "Push Update" reaches tablets on supported versions.
- [ ] Update status shown is the **real heartbeat-reported** state, not just the launch ack (v2.39.2).

## 25. Distribution / Installer
*`deploy/BUILD-INSTALLER.bat`, `deploy/installer.nsi`*

- [ ] ⚠️ **GUARD** Installer is **self-cleaning**: stops + removes the app **and** gateway services, disables SCM auto-restart first, kills install-dir node/nssm, **before** file copy — no "error opening file for writing node.exe" (v2.42.2).
- [ ] ⚠️ **GUARD** In-place upgrade **preserves** `database.db` + `config.json` in `C:\ProgramData\CommissioningTool`.
- [ ] Installs both services (central: `CommissioningTool` + `CommissioningGateway`, `PLC_MODE=remote`); auto-start on boot.
- [ ] Defender path exclusion best-effort + timeout-bounded (never hangs the installer).
- [ ] Build version comes from `package.json` / `APP_VERSION` — never the stale hardcoded default.

---

## How to use this before a release
1. Run the **battle rig** (`SCENARIO=central`, scale `MCM_COUNT` for multi-MCM) — it auto-checks every 🧪 item (I1–I10).
2. Manually verify the **UI-only** items the rig is blind to (per-MCM display, VFD wizard click-flow) — the rig drives the API, not the browser.
3. Walk the ⚠️ **GUARD** items by hand on the target build — these are the paths that caused real field incidents.
4. Install the EXE on a clean box and confirm §25 (self-clean + preserve DB/config).
