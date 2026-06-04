# VFD Bump Test Blocker Capture + Early Local Controls — Design

Date: 2026-06-04
Origin: Kevin's feedback (taskboard #2170 "Motor bumping feedback for electrical or mechanical action items") + Update 6/3.

## Problem

1. When the VFD wizard's Bump Test (Step 3) bumps the motor and nothing happens (belt too
   loose/tight, VFD noise, drive faults), the tester has **no way to capture this** and route
   it to the responsible vendor. The note must become a filterable flag on the external
   mechanical dashboard (installation-tracker) and be visible to electrical (commissioning
   dashboard).
2. Mech doesn't get the local F0/F1/F2 keypad controls until the VFD is "ready for tracking"
   (all `Valid_*` AOI flags). If the bump fails → never ready → mech has no controls to
   troubleshoot. Kevin: *"we need to enable the controls as soon as VFD identity is established."*

## Decisions (agreed with Ilia 2026-06-04)

- **Propagation**: new **device-level sync op** local→cloud. Cloud resolves the shared
  `Devices` row (tracker-owned) and writes ONLY `BlockerResponsibleParty` +
  `BlockerDescription` — the same two columns all three apps already share
  (see frontend/lib/blockers.ts header). Confirmed in prod DB: VFDs exist as
  `Devices` rows (`DeviceType='VFD'`, names match wizard device names like `UL9_9_VFD1`),
  with linked `ios` rows (`ios.device_id`) but **no Io row for the VFD itself** — hence a
  device-level op instead of riding the per-IO sync.
- **[Other] text**: stored as `Other: <typed text>` directly in `BlockerDescription`.
  No Devices schema change. Visible verbatim on tracker + cloud dashboards.
  `[Other — please specify]` is the ONLY way to enter an open-ended comment; the comment
  is required when Other is picked.
- **Vocabulary**: a **separate** VFD vocabulary (NOT merged with the IO-check
  `BLOCKER_VOCAB`), three parties only — no 3rd Party. Hand-mirrored to
  commissioning-cloud `lib/blockers.ts` (same convention as existing vocab).
  Tracker needs no vocab change (its description field is free-form).

  | Party | Blocker Descriptions |
  |---|---|
  | Controls | VFD did not turn on · Other |
  | Electrical | VFD Faults Immediately · VFD Faults after Running · VFD turns on, motor doesn't move, motor fan doesn't move · Other |
  | Mechanical | VFD turns on, drive shaft moves, belt is slipping · VFD turns on, drive shaft doesn't move · VFD turns on, belt moves, makes harsh noise · Other |

  ("draft shaft" in the original memo is a typo for "drive shaft".)
- **Lifecycle**: after recording, Step 3 shows a red "Blocked — assigned to <party>" state,
  persisted in a new L2 cell **`Bump Blocker`** (survives reopen, visible on other laptops,
  audited via `l2_cell_history`). Re-bumping stays available. When the user later commits
  direction (Set Normal / Invert → `Check Direction` stamped), the tool **auto-clears**:
  empties the L2 cell and sends a *conditional* clear op — the cloud nulls the Devices pair
  only if the current values still match what the tool recorded, so a blocker set meanwhile
  by the tracker/coordinator is never wiped.
- **F0/F1/F2**: the keypad unlock lives in the AOI rungs ("ready for tracking" gating).
  Tool-side: change `lib/vfd-validation-writer.ts` from "assert all flags once
  `Check Direction` is stamped" to **per-flag assertion** — assert `Valid_Map` as soon as
  *Verify Identity* is stamped, `Valid_HP` once both HP cells are filled, `Valid_Direction`
  (+ polarity bits) once *Check Direction* is stamped. This makes identity durable across
  PLC downloads/power-cycles mid-wizard. **AOI hand-off (Kevin/controls, out of tool scope):
  gate the keypad enable on `Valid_Map` alone** so mech gets F0/F1/F2 right after identity.
  Never write 0s for un-stamped flags (un-validation only happens via the explicit clear pulses).

## Architecture

```
Wizard Step 3 "Bump didn't work?" button
  → VfdBumpFailDialog (party → description cascade, Other ⇒ required comment)
  → on submit:
      1. L2 cell "Bump Blocker" = "<stamp> · <party> · <description>"   (graceful skip if column absent)
      2. POST /api/vfd-commissioning/bump-blocker  (local Express route)
           → enqueue DeviceBlockerPendingSyncs row (op='set')
           → instant push attempt; 30 s background retry loop drains the rest
  → cloud POST /api/sync/device-blocker
      resolve Devices row:  ios(subsystem) ⨝ Devices on device_id WHERE Devices."Name" = deviceName
      op 'set'   → write both Blocker columns
      op 'clear' → null both columns ONLY IF current values == expected values
  → tracker VFD Install tab (already shows + filters both columns — zero tracker changes)
  → cloud IO grid (already surfaces Devices.Blocker* on the VFD's IO rows — zero changes)

Direction committed (Check Direction stamped)
  → if Bump Blocker cell non-empty: clear cell + enqueue op='clear' with expected pair
```

## Non-goals

- No tracker (installation-tracker) code changes.
- No `Devices` schema changes.
- No AOI/PLC program changes (documented hand-off to Kevin).
- The cloud coordinator IO-grid triage dialog keeps its generic vocabulary (device-level
  VFD blockers can be edited free-form from the tracker, or cleared by re-running the bump).

## Deploy notes

- New L2 column **`Bump Blocker`** must be provisioned on VFD/APF sheets in commissioning-cloud
  (script in commissioning-cloud/scripts/). The wizard degrades gracefully when the column is
  missing: the Devices sync op still fires; only the durable red-state restore is lost.
- commissioning-cloud must deploy **before or together with** the field-tool release
  (otherwise the new sync op 404s and sits in the retry queue — which is acceptable and
  self-heals, same as offline operation).
