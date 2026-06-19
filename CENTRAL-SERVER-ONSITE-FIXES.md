# Central Server — On-Site Debugging Campaign (2026-06-19)

Durable record of the central-server (CDW5, MCM06 laptop, `PLC_MODE=remote`) fixes
shipped v2.42.1 → v2.42.5, the root causes, how each was verified, and what remains.
Code is committed on `main` (GitHub + GitLab). EXEs are on the GitHub Releases page.

---

## Releases (cumulative — v2.42.5 is the on-site release)

| Version | Fix | Layer |
|---|---|---|
| **v2.42.1** | Per-MCM **page scoping** — views fed the route subsystem (`paramId`), not the mutable singleton `plcConfig.subsystemId` (clobbered by the PLC status broadcast). MCM01 shows MCM01. | client UI |
| **v2.42.2** | Installer self-clean: **disable SCM auto-restart** (`sc config start=disabled` + `sc failure … actions=""`) before stopping, so recovery can't respawn mid-copy. | installer |
| **v2.42.3** | Installer: **kill service by SCM PID** (`taskkill /F /T /PID`) — a LocalSystem service's `node.exe` has a null `ExecutablePath`, so the path-filtered kill skipped it. | installer |
| **v2.42.4** | (1) Per-MCM **L2/FV pull** — the per-MCM pull route deliberately skipped L2, so only the server's own MCM got FV. (2) **Status bar per-MCM** — `/api/network/chain-status` read the fleet-wide tag union. | client + server |
| **v2.42.5** | Installer: **`taskkill /F /IM node.exe`** by image name — the real on-site lock was an **orphaned node.exe with NO service** (prior `sc delete` left the process running); service/path-based kills all missed it. | installer |

---

## Root causes (each diagnosed, not guessed)

### A. FV / L2 empty for every MCM except the server's own (v2.42.4)
- **Divergence:** `app/api/mcm/[subsystemId]/pull/route.ts` *intentionally skipped L2*. So `connect-all` / `pull-all` (the central-server bulk actions) pulled IOs for every MCM but **L2 only for the legacy `config.subsystemId`** (MCM06, via `/api/cloud/pull`). The auto-sync L2 backfill (`auto-sync.ts:~1137`) is gated on `m.ip` — most central MCMs have blank IP — so it skipped them too.
- **Cloud is fine — verified READ-ONLY on prod** (`commissioning-db`, db `autstand`): `l2_devices` holds L2 for **all** MCMs (MCM01=517 … MCM06=379 … MCM19=35; only 10 of 6,408 untagged). The data was there; the field tool never requested it per-MCM. **No production change.**
- **Fix:** the per-MCM pull now self-calls `/api/cloud/pull-l2` scoped to that subsystem. `pull-l2` deletes/inserts only `WHERE SubsystemId=?` and upserts global `l2_sheets`/`l2_columns` by CloudId → no cross-MCM clobber. One Pull / Connect-All now fills FV for every MCM.
- **NOTE (cloud, low-risk):** cloud `sync/l2/[subsystemId]` filters devices by free-text `subsystem`/`mcm` name vs `Subsystem.name`, and `subsystems` has duplicate names across projects (8× "MCM01"…) — scoped by `sheetId` per project so it works, but it's fragile. A real `subsystem_id` FK on `l2_devices` would be the durable cloud fix. NOT done (don't-touch-prod).

### B. Top status bar ("cloud/backend/plc NNNN") identical on every MCM page (v2.42.4)
- `/api/network/chain-status` read `getPlcTags()` = the **union of every MCM's tags** (the "3528"). The component `NetworkStatusBreadcrumbs` was rendered with no subsystem.
- **Fix:** `chain-status` now takes `?subsystemId=` (uses `getMcmStatus`/`getMcmTags`), and `page.tsx` passes the route subsystem through the component. Bar reflects that MCM's connection + its own tag count.

### C. Installer "error opening file for writing node.exe" — recurred 4× (v2.42.2 → v2.42.5)
The lock survived three fixes because each assumed the wrong thing:
1. v2.42.2 — thought it was the gateway's **SCM recovery** respawning it (real, but not the whole story).
2. v2.42.3 — thought the kill missed it because a **LocalSystem service's `node.exe` has a null `ExecutablePath`** (real blind spot, fixed by killing by service PID).
3. **v2.42.5 — the actual on-site cause: an ORPHANED `node.exe` with NO owning service.** A prior `sc delete` removed the service but left `node.exe` running from `C:\Program Files (x86)\CommissioningTool\node.exe`. Service-based kills find no service; the path-filter missed it. **Fix:** plain `taskkill /F /IM node.exe` (+ `nssm.exe`) by image name before the copy — safe on a dedicated central box.
- **Manual unblock (any version):** `Get-Process node,nssm | ? { $_.Path -like '*CommissioningTool*' } | Stop-Process -Force`, then install.

---

## CI/CD (proper coverage now in place)
- **Registry images were 10 days stale** (`tool:central` from Jun 9) — the nightly + central pipelines were testing OLD code. Pushed current `tool:central`/`tool:latest`/`cloud:latest`/`plc-sim:latest` so CI tests the real backend.
- **Daily site-topology schedule enabled** — GitLab schedule #2 now runs `central-cdw5-split` (19-MCM, `PLC_MODE=remote`) daily at 12:00. Nightly battle soak (#1, 02:00) + both runners healthy.
- **Battle validation this campaign:** 10-MCM local soak fully green (I1–I10). 19-MCM CDW5 CI: all safety invariants green (connect, no-loss, VFD restore, SSE, backups, stable); I10 red is a **seed gap** (the CDW5 dump's `l2_devices` use free-text names, no `subsystem_id` — see note A), not a tool defect.

## Test coverage
- Functional checklist: `FUNCTIONALITY-CHECKLIST.md` (25 areas, GUARD + battle markers).
- Battle scenarios + gaps: `battle/TEST-COVERAGE.md`. Local 10-MCM scaling added to `battle/ci/run_scenario.sh` (`MCM_COUNT>4` → `central-scale` profile, sims 5–10).

## Remaining / optional (none block site)
1. **Auto-sync L2 backfill is IP-gated** (`auto-sync.ts`) — blank-IP MCMs rely on explicit Pull/Connect-All (which now pulls L2). Loosen the gate for hands-off background backfill.
2. **Cloud `l2_devices` → `subsystem_id` FK** (note A) — durable cloud-side fix for the free-text name matching; needs a prod migration.
3. **I10 on the CDW5 CI seed** — make the invariant tolerant of L2-less / name-only seeds, or add `subsystem_id` to the seed, so the 19-MCM gate goes green.
