# Network Comms Ring Commissioning — Design

**Status:** approved (brainstorm 2026-07-08), not yet built.
**Owner surface:** field tool (`frontend/`), local-only in Phase 1.
**Related:** `2026-05-26-network-ring-health-research.md`, `ring-health-explained.md`
(the existing DLR ring-health badge), `components/network-topology-view.tsx`,
`components/network-diagnostics-view.tsx`, `lib/plc/network/` (poller/parser/dlr).

---

## Problem

The comms ring — the DLR ring formed by the **DPMs** (Data Power Modules /
managed switches) plus the **EN2TR/EN4TR** network modules in the PLC rack — can
be wired switch-to-switch on *arbitrary ports* and still pass traffic, so it can
be fully "green" while not matching the engineering drawings. This happened at
**MTN6**. Today the tool shows the *expected* leaf-device wiring and whether each
device is *communicating*, and (via CIP `0xF6`) per-port link/speed/media health,
and (via the DLR object) ring closed/open — but it can prove neither the exact
**switch→switch port pairing** nor that the actual wiring matches the design.

Goal: verify, **from one point** (the field laptop), that the ring's switches are
connected to the right switches on the right ports, that leaf devices sit on their
drawn ports, that the ring is closed, and that terminations are clean — and catch
the MTN6 "arbitrary-but-working" mis-wire.

## Non-negotiable constraints (from the field)

This is **not core functionality**. The tool must survive without it. Therefore:

1. **On-demand only.** No background/continuous SNMP polling. The feature runs
   **only** when the operator presses **Capture** or **Check**. The existing
   always-on network poller and DLR read are untouched.
2. **Fully isolated + fail-safe.** All new code lives in its own modules behind
   its own API routes and its own UI panel. Every external read is
   timeout-bounded and wrapped so it can **never** throw into, lag, or crash the
   main tool. If it doesn't work on a site, it degrades to a clear "couldn't
   read — test on-site" state and nothing else is affected.
3. **Lazy, optional dependency.** The SNMP library is `require`d lazily at first
   use. If it is missing or fails to load, the feature self-disables; the rest of
   the tool starts and runs normally.
4. **Additive only.** New SQLite tables (`CREATE TABLE IF NOT EXISTS`), new
   namespaced routes, new optional `config.json` block. Zero changes to the
   testing grid, sync queue, PLC lifecycle, or existing network poller.
5. **Local-only in Phase 1.** Baseline is stored in local SQLite and works fully
   offline. Cloud sync is an explicit **Phase 2**, out of scope here.

## What each source can and cannot tell us (from one point)

| Source | Gives | Already in tool? |
|---|---|---|
| **DLR object** (EN2TR/EN4TR supervisor, CIP `0x47`) | ring closed/open, participant count, break localization (nodes bracketing a break) | ✅ built (`dlr.ts`) |
| **CIP Ethernet Link `0xF6`** | per-port link/speed/duplex + interface/media counters (termination health) | ✅ built (diagnostics) |
| **LLDP-MIB** (SNMP) | exact switch→switch pairing: "DPM-A port 3 ↔ DPM-B port 1" | ❌ new |
| **BRIDGE-MIB FDB** (SNMP, `dot1dTpFdbPort`) | which MAC is learned on which switch port → leaf-device placement | ❌ new |
| **Vendor ring MIB** (SNMP) | ring role/state for non-DLR rings (Moxa Turbo Ring, Hirschmann MRP) | ❌ new |

CIP alone **cannot** yield port-to-port topology (it reports a port's own state,
not what is on the other end). Exact-port verification therefore requires SNMP.

## Approach — capture → confirm-against-print → lock (golden baseline)

1. **Capture.** On a known-good ring the operator presses **Capture Ring
   Topology**. From one point the tool reads: DLR ring state (existing) + LLDP
   uplinks + FDB leaf placement (new SNMP) + live `0xF6` termination health
   (existing). It assembles an `ActualTopology`.
2. **Confirm vs print.** The captured topology is shown **side-by-side with what
   the tool already knows** (leaf ports from `NetworkPorts`). The operator
   eyeballs it against the paper drawing **once** — this human step is what makes
   the baseline authoritative for MTN6 — corrects/confirms, then presses
   **Confirm & Save Baseline**.
3. **Lock.** The confirmed topology is saved as the approved `RingBaseline`
   (local SQLite, with who/when).
4. **Check.** Later, **Check Ring** re-reads and compares to the locked baseline,
   producing per-link and per-port verdicts: `match` / `mismatch (wrong port)` /
   `missing` / `unexpected` / `termination-fault` / `ring-open`. Green ⇔ matches
   the drawing-confirmed baseline **and** terminations are clean.

Without the human "confirm vs print" step the tool can only prove *"unchanged
since capture,"* not *"matches design."* That step is the feature's authority.

## Architecture

New code under `frontend/lib/plc/network/ring-commissioning/` (sibling of the
existing network modules), split into small single-purpose units:

```
ring-commissioning/
  types.ts            # ActualTopology, RingBaseline, verdicts (pure types)
  snmp/
    client.ts         # lazy net-snmp wrapper: get/walk, timeout, never throws
    mibs.ts           # OID constants: LLDP-MIB, BRIDGE-MIB, Moxa, Hirschmann MRP
    adapters/
      generic.ts      # standard LLDP + FDB (vendor-neutral)
      moxa.ts         # + Moxa Turbo Ring MIB ring-state
      hirschmann.ts   # + Hirschmann MRP MIB ring-state
      index.ts        # pick adapter by device identity/vendor hint
  capture.ts          # orchestrate reads for a ring → ActualTopology (impure)
  compare.ts          # ActualTopology vs RingBaseline → verdicts (PURE, unit-tested)
  baseline-repo.ts    # local SQLite read/write of RingBaselines
```

- **`compare.ts`** is pure and fully unit-tested — it is the heart of the feature
  and the part that must be correct regardless of hardware.
- **`snmp/client.ts`** lazy-`require`s `net-snmp` (pure-JS, no native build — safe
  for the portable bundle). On load failure it returns
  `{ available: false, reason }`; callers surface that as a friendly UI state.
- **Adapter selection**: the ring-state read is vendor-specific (DLR for Rockwell,
  Turbo Ring for Moxa, MRP for Hirschmann); LLDP + FDB are shared. DLR stays read
  by the existing `dlr.ts` — the adapter layer only adds the SNMP vendors.

### Data model (additive, local SQLite)

```sql
CREATE TABLE IF NOT EXISTS RingBaselines (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  SubsystemId   INTEGER NOT NULL,
  RingId        INTEGER,              -- FK to NetworkRings (nullable; ring may be unmodeled)
  RingName      TEXT,
  CapturedAt    TEXT NOT NULL,
  ApprovedBy    TEXT,
  ApprovedAt    TEXT,
  TopologyJson  TEXT NOT NULL         -- the confirmed ActualTopology blob
);
```

JSON blob (not normalized) keeps the surface tiny and matches the "not core,
low-risk" ethos. One approved baseline per (SubsystemId, RingName); re-approving
replaces it (previous kept as history rows is a possible later nicety, not now).

### Config (additive, optional `config.json`)

```json
"snmp": {
  "enabled": false,
  "version": "v2c",            // or "v3"
  "community": "public",       // v2c
  "port": 161,
  "timeoutMs": 2000,
  "retries": 1
}
```

Absent or `enabled:false` → the feature shows "SNMP not configured" and offers
nothing that reads switches. Switch IPs come from `NetworkNodes.IpAddress`.

### API routes (namespaced, all wrapped)

`POST /api/network/ring/capture`   → read actual, return `ActualTopology` (no save)
`POST /api/network/ring/baseline`  → save the operator-confirmed baseline
`GET  /api/network/ring/baseline`  → fetch stored baseline for a subsystem
`POST /api/network/ring/check`     → read actual + compare → verdicts

Every handler: input-validated, SNMP calls timeout-bounded, all failures →
structured `{ ok:false, reason }` (HTTP 200 with a body, never a 500 cascade).

### UI

A new **Ring Commissioning** section on the existing Network page (separate from
the topology diagram and testing grid — no shared state with core UI). Controls:
**Capture** → review panel (captured vs known, editable) → **Confirm & Save
Baseline**; and **Check** → verdict panel (per-link/port match/mismatch,
ring state, termination health, "what's wrong and where"). Reuses the existing
status-dot / diagnostics visual language. When SNMP is unconfigured/unavailable,
the section renders an explanatory empty state, never an error.

## Verdict model (pure, unit-tested in `compare.ts`)

Per switch→switch link and per leaf placement, comparing actual to baseline:

- `match` — same neighbor on the same local+remote port.
- `wrong-port` — right neighbor, wrong port (the MTN6 case).
- `wrong-neighbor` — different device than the drawing.
- `missing` — baseline link absent in actual (cable pulled / device down).
- `unexpected` — actual link not in baseline (added/mis-patched).
- `termination-fault` — link present but `0xF6` shows media errors / wrong speed /
  half-duplex where full expected.
- Ring-level: `closed` / `open` (+ break localization) from DLR or vendor MIB.

Ring verdict = **all links `match` AND ring `closed` AND no `termination-fault`**
→ Healthy; otherwise Degraded with the specific offending links listed.

## Error handling & isolation guarantees

- SNMP unreachable / library missing / timeout → `{ ok:false, reason }`, friendly
  UI, **no** effect on the rest of the tool.
- No background timers; nothing runs unless the operator presses a button.
- New tables created with `IF NOT EXISTS` on the existing startup migration path.
- Feature can be shipped dark (config `enabled:false`) and turned on per-site.

## Testing

- **Unit (Vitest):** `compare.ts` verdict permutations (match / wrong-port /
  wrong-neighbor / missing / unexpected / termination-fault / ring open+closed);
  MIB OID encode/decode; LLDP + FDB response parsers against captured fixture
  buffers; adapter selection; `snmp/client.ts` load-failure path returns
  `available:false` (never throws).
- **Field-unverified (documented):** the live SNMP read path cannot be validated
  on the bench (Emulate 5580, no real ring/switches) — exactly like the DLR
  reader. It ships flagged "field-unverified" until it runs on MTN6/CDW5.
- **Battle rig:** unaffected — feature is off without SNMP config; add a note.

## Deliverable

A **how-it-works PDF** (what it checks, how it reads from one point, the
capture-confirm-lock flow, what each source contributes, setup, and the honest
field-unverified limitation) for attaching to the review task.

## Out of scope (explicit)

- Cloud sync of baselines (Phase 2).
- Auto-remediation / writing to switches (read-only forever).
- Continuous monitoring / alerting on ring drift (on-demand only by design).
- Modeling switch→switch uplinks in the cloud data model (baseline captures them
  locally instead).
