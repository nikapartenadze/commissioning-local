# Battle-Test Coverage & Gap Analysis

Goal: every situation that can occur on site is automated and gated **before** an
installer is built and deployed. This doc is the source of truth for what the rig
covers and what it does NOT yet cover. Update it whenever a scenario/invariant is
added or a new incident class is found.

---

## Part 1 — What is tested today

### Scenarios (`ci/run_scenario.sh`)
| Key | Throws | Topology |
|---|---|---|
| `s1` | clean scale soak | single-MCM |
| `s2` | PLC program-download storm | single-MCM |
| `s3` | cloud connectivity flap | single-MCM |
| `s6` | CIP-saturated controller (delay) | single-MCM |
| `mutate` | cloud-side edits/additions | single-MCM |
| `central` | 4 registry MCMs + cloud SSE + flap + **FV/L2 writes** | central, embedded |
| `central-cdw5` | 19 real CDW5 MCMs | central, embedded |
| `central-cdw5-split` | 19 MCMs, `PLC_MODE=remote` + gateway | **the SITE topology** |
| `central-cdw5-live` | against real emulator controllers | central, remote, real PLC |
| `all` | everything at once | single-MCM (nightly) |

Weekday rotation: Mon `s2`, Tue `s3`, Wed `central`, Thu `mutate`, Fri `s3`, Sat `s6`, Sun `central`.

### Invariants (`observer/probe.py`)
| ID | Checks | Gate |
|---|---|---|
| I1 | responsiveness (`/api/health` p95 + max gap) | GATE |
| I2 | no memory leak (RSS slope) | GATE |
| I3 | flag/VFD/polarity restore after PLC download | GATE |
| I4 | no data loss (journal survives; `suspect_silent_drops`) | GATE |
| I5 | stability (server starts / PLC flaps vs budget) | GATE |
| I7 | cloud→field propagation (mutate) | report |
| I8 | SSE live-channel auth (401/403) | GATE |
| I9 | bounded auto-backups | GATE |

### Crew behaviors (`crew/bot.mjs`)
IO Passed/Failed/Cleared (SPARE-aware, partitioned single-writer, hot-set version races); **FV/L2 cell writes per MCM** (`FV_FRACTION`).

### Chaos (`chaos/chaos_api.py`)
`download` (PLC program download), `power` (PLC power loss), `delay` (CIP saturation), `toolkill` (tool crash/restart), `cloudcut` (internet flap), `calm`.

---

## Part 2 — Gaps (situation → tested?)

Severity = blocking risk for a site deploy. **BLOCKER** = do not ship without it.

### A. Multi-MCM data isolation (central server)
| Situation | Status | Sev |
|---|---|---|
| Each MCM has its own **IO** data | ✅ tested (`central`: 4× own 1,184 IOs) | — |
| Each MCM has its own **L2/FV** data (no cross-wipe) | 🟡 unit-tested; rig demo in progress (seeder now clones L2 per MCM) | HIGH |
| Each MCM has its own **network** data | ❌ not tested (`network=0` in seed — no per-MCM rings) | HIGH |
| Each MCM has its own **E-Stop** data | ❌ not tested per MCM | MED |
| Per-MCM **connection status** to cloud (no false "Red") | ❌ no invariant (fix shipped, not gated) | HIGH |
| Per-MCM **firmware/compliance** | ❌ not tested per MCM | MED |
| L2/FV **push→cloud drain** for multiple MCMs | ❌ cloud-stage has no per-MCM L2 | HIGH |

### B. Sync / data-safety
| Situation | Status | Sev |
|---|---|---|
| No silent drop on 429 / version-cap | ✅ I4 / B1 | — |
| Offline IO writes survive + drain on reconnect | ✅ I4 offline queue | — |
| Offline **L2/FV** writes survive + drain | 🟡 queued-safe shown; full drain for clones blocked on cloud L2 seed | HIGH |
| **Long** offline (days/week) then reconnect drains | ❌ only ~12-min flaps; no time-compressed multi-day outage | HIGH |
| Pull refused while PLC connected | ❌ guard not exercised | MED |
| Pull refused with unsynced local work (409) | ❌ guard not exercised | MED |
| Backup **restore** path works | ❌ creation/retention tested, restore not | MED |
| Schema migration on upgrade (old DB → new cols) | ❌ not tested (e.g. the new `L2Devices.SubsystemId`) | HIGH |
| Concurrent same-cell L2 edits / version conflict | ❌ hot-set is IO-only | MED |
| Cloud→field **VFD ADDRESSED** propagation (mechanic marks on cloud → field VFD tab pulls it) | ❌ proven MANUALLY end-to-end (2026-06-27); no battle gate. Needs a `mutate`-style step that marks a blocker addressed on cloud + an observer check that the field `VfdAddressed` mirror got it. Closest is I7 (general cloud→field, report-only). | HIGH |

### C. Connectivity / auth
| Situation | Status | Sev |
|---|---|---|
| Cloud flap (cut/restore) | ✅ s3 / cloudcut | — |
| SSE auth 401/403 (the MCM11 "Red") | ✅ I8 | — |
| Wrong/rotated API key mid-session | ❌ | MED |
| Cloud 500/503/timeout on push (not just 429) | ❌ only 429/cut tested | MED |
| **Auth ENABLED** (central tool auth is built-but-disabled) | ❌ all runs are anon-admin | HIGH |
| DNS-fail vs refused vs slow (distinct modes) | ❌ only hard cut | LOW |

### D. PLC / hardware
| Situation | Status | Sev |
|---|---|---|
| PLC program download → flag restore | ✅ I3 | — |
| PLC power loss / reconnect | ✅ chaos power | — |
| CIP saturation | ✅ s6 | — |
| **Polarity-specific** writeback after download (belt-reversal risk) | 🟡 I3 checks VFD validation generally — not a polarity-only assertion | HIGH |
| Simultaneous downloads on multiple MCMs | ❌ | MED |
| `PLC_MODE=remote` gateway in routine gate | ❌ split scenario is manual-only | HIGH |
| Gateway process crash/restart | ❌ | MED |
| libplctag handle-leak over long uptime ("must restart") | ❌ not a long-soak gate | HIGH |
| Wrong-PLC routing rejected | 🟡 only in `central-cdw5` (manual) | MED |

### E. Process / resource / longevity
| Situation | Status | Sev |
|---|---|---|
| Memory leak | ✅ I2 | — |
| Tool crash/restart recovery | ✅ toolkill | — |
| **Disk full** (the 4 GB incident) — graceful degrade | ❌ I9 bounds backups, but disk-full *behavior* untested | HIGH |
| Multi-week uptime (handle/log/WAL growth) | ❌ max soak 8 h | MED |
| Log rotation / log-disk usage (tag-events were huge) | ❌ | MED |
| Multiple tablets against one central tool | ❌ single crew→one tool | MED |

### F. The shipped artifact (installer/EXE) — **the biggest gap**
| Situation | Status | Sev |
|---|---|---|
| Battle tests the **Docker image**, not the Windows **installer/EXE** | ❌ | **BLOCKER** |
| Fresh NSIS install boots + connects PLC | ❌ | **BLOCKER** |
| Upgrade-over-existing preserves data + migrates schema | ❌ | **BLOCKER** |
| `vcruntime140.dll` / `plctag.dll` present (the "os error 126") | ❌ not smoke-tested on the built artifact | HIGH |
| Windows service auto-start (NSSM) | ❌ | MED |
| Cloud-pushed auto-update apply + rollback | ❌ | HIGH |
| Portable ZIP runs from a clean machine | ❌ | MED |

### G. Functional flows
| Situation | Status | Sev |
|---|---|---|
| VFD **wizard** end-to-end (writes L2 cells + PLC tags) | ❌ bots write cells directly, not via wizard | HIGH |
| Guided mode / task pool | ❌ | MED |
| E-Stop check flow | ❌ | MED |
| Report generation / export | ❌ | LOW |
| Firmware compliance read + verdict | ❌ | LOW |

---

## Part 3 — Priorities before building & deploying the installer

**Must-close (BLOCKER / HIGH) before an installer ships to site:**
1. **Smoke-test the actual built artifact** (installer + portable ZIP), not just the Docker image — fresh install, upgrade-over-existing with data preservation + schema migration, and a PLC connect (catches the `vcruntime`/`plctag.dll` class). This is the single biggest gap.
2. **Per-MCM isolation, gated** — finish the L2 demo (in progress), add **network** + **per-MCM connection-status** invariants, and seed cloud-stage with per-MCM L2 so FV **push→drain** is proven for all MCMs.
3. **Polarity-writeback-specific gate** — assert `Normal_Polarity`/`Reverse_Polarity` (not just "VFD validation") is re-written after every download; this is the belt-reversal/VFD-damage path.
4. **`PLC_MODE=remote` (gateway) in the routine gate** — the site runs split mode; today only `central` (embedded) runs nightly.
5. **Long-outage drain** — a time-compressed "offline for days → reconnect → full drain to 0" case.
6. **Schema-migration-on-upgrade** + **backup-restore** + **disk-full degrade** + **handle-leak long soak**.
7. **Auth-enabled** runs once the central tool turns auth on.

**Process rule:** the installer build step should be **gated on a green `central` + `s2` + `s3` + a built-artifact smoke**, and this doc reviewed, before any site deploy.

---

## Part 4 — Cloud↔field per-data-type sync coverage (2026-06-27)

A coverage-keeper sweep asked the direct question: is **every kind of data** synced
both directions actually tested? Result — IO pass/fail was solid; the rest had no
**unit** coverage of the sync path itself. Five new unit-test files now gate the
sync LOGIC for each data type (in-memory SQLite + mocked cloud; run by
`frontend-verify` in CI). The remaining gap for every one is the same: the
**live end-to-end propagation under chaos**, which only the battle rig can reach.

| Data type | Direction now UNIT-gated | Test file | Battle (live propagation) |
|---|---|---|---|
| IO pass/fail + comments | both | (pre-existing) | ✅ I4 / I11 / I12 |
| **VFD ADDRESSED** | cloud→field pull + cloud-authoritative upsert | `vfd-addressed-sync.test.ts` | ❌ gap (this Part) |
| **L2 / FV cell** | field→cloud push+drain **and** cloud→field version-gated LWW merge | `l2-fv-sync-coverage.test.ts` | ❌ gap (this Part) |
| **E-stop definitions** | cloud→field zone→EPC tree pull + no-op-no-wipe | `estop-sync-coverage.test.ts` | ❌ gap (this Part) |
| **Network topology** | cloud→field cascade-replace pull + port-id remap | `network-sync-coverage.test.ts` | ❌ gap (this Part) |
| **Firmware baseline** | cloud→field wholesale-replace pull/cache | `firmware-sync-coverage.test.ts` | n/a (field→cloud fw is live-PLC `ControllerPushSnapshot`, hardware-only) |

### The one battle scenario that closes the live-propagation gaps: `crud-propagation`

All five gaps share a root cause documented in the delta-sync note: **cloud SSE
emits result updates, not definition/CRUD changes** — so an ADDRESSED mark, an L2
cell edit, an e-stop zone edit, or a network change reaches a tablet only via a
(scoped) pull. Author ONE scenario that drives each cloud-side and asserts arrival:

- **Scenario (`crud-propagation`)** — extend `cloud-mutator` to, on a real subsystem:
  (a) mark a belt VFD blocker **ADDRESSED**, (b) edit an **L2/FV cell** value,
  (c) edit an **e-stop zone/EPC**, (d) edit a **network ring/port**. Run with a
  drained queue (like `delta`/`mutate`, `HOT_FRACTION=0`) so the scoped pull fires.
- **Observer invariants (REPORT-ONLY first; green ×2 before gating, skill rule #4):**
  - **I14 ADDRESSED-propagation** — field `VfdAddressed` for the subsystem matches
    the cloud mark; other MCMs untouched.
  - **I15 L2/FV-propagation** — field `L2CellValues` row converges to cloud
    value+version; an **older**-version cloud echo never clobbers a locally-newer
    cell (the LWW negative case).
  - **I16 estop-def-propagation** — field `EStopZones` for the edited subsystem
    converges; **other MCMs' zones are NOT wiped** (the legacy global
    `/api/cloud/pull-estop` wipes globally vs. the per-MCM scoped pull — pin which
    path runs so a cross-MCM wipe reds the build).
  - **I17 network-propagation** — field `NetworkRings/Nodes/Ports` converge for the
    subsystem; cascade leaves no orphan ports; no cross-MCM wipe.
- **Seeder need** — cloud-stage must carry **distinct per-MCM** L2 cells, e-stop
  trees, and network rings (today it has none/!per-MCM), and a mutation injector
  to emit each edit. This is the same "seed cloud-stage with per-MCM L2" item in
  Part 3 #2, generalized to all four data types.

Until `crud-propagation` runs green, the live cloud→field delivery of these data
types is **unit-proven (the merge/pull logic) but not integration-gated** — state
that honestly in any release note. The push direction for L2/FV is unit-gated;
its multi-MCM drain-to-cloud is still the Part 3 #2 item.
