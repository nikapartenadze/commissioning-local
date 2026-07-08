# Network Comms Ring Commissioning — How It Works

*Plain-language explainer for the controls/commissioning team. Companion to the
DLR ring-health note (`ring-health-explained.md`) and the design/plan in
`2026-07-08-network-ring-commissioning-design.md`.*

## What it proves

The comms ring — the DLR ring formed by the **DPMs** (Data Power Modules /
managed switches) plus the **EN2TR/EN4TR** network modules in the PLC rack — can
be cabled switch-to-switch on *arbitrary ports* and still pass traffic. So a ring
can look completely "green" while not matching the engineering drawings. This is
what happened at **MTN6**: the wiring worked, but the ports were not what the
print said.

Ring Commissioning answers, from **one point** (the field laptop), four questions
the normal "is it green?" view cannot:

1. Is each **switch cabled to the right switch, on the right port**? (the MTN6 check)
2. Is each **leaf device on the switch port it's drawn on**?
3. Is the **ring actually closed** (redundancy intact), not just passing traffic?
4. Are the **terminations clean** — right speed, full duplex, no media errors?

## How it reads — one point, four sources

| Source | What it gives | How |
|---|---|---|
| **DLR object** (EN2TR/EN4TR supervisor) | ring closed/open + where a break is | CIP `0x47`, read-only (already in the tool) |
| **LLDP** (each switch) | exact "DPM-A port 3 ↔ DPM-B port 1" pairing | SNMP LLDP-MIB |
| **Bridge FDB** (each switch) | which device sits on which switch port | SNMP BRIDGE-MIB |
| **CIP `0xF6`** (per port) | link, speed, duplex, media/interface counters | already in the tool (Diagnostics) |

The port-to-port pairing is the part CIP alone can never give — a CIP read tells
you a port's *own* state, not what is on the other end of the cable. That is why
the exact-port check needs SNMP (LLDP + FDB), which is also how non-Rockwell
switches (Moxa Turbo Ring, Hirschmann MRP) are read.

## How it checks — capture → confirm against the print → lock

1. **Capture.** On a known-good ring, press **Capture Ring Topology**. The tool
   reads all four sources and assembles the *actual* wiring.
2. **Confirm against the print.** It shows what it captured; you eyeball it
   against the paper drawing **once**. *This human step is what makes the check
   authoritative* — it's the difference between "matches the design" and merely
   "hasn't changed." (The MTN6 lesson: a first wiring can be wrong, so a machine
   that only remembers the first capture would bless the mistake.)
3. **Lock.** Press **Confirm & Save Baseline**. The confirmed wiring is saved as
   the approved golden baseline for that ring.
4. **Check.** Later, press **Check Ring**. The tool re-reads and compares to the
   locked baseline, and reports exactly what's wrong and where:

   - **Match** — right neighbor, right ports.
   - **Wrong port** — right neighbor, wrong port (the MTN6 case).
   - **Wrong neighbor** — a drawn port goes to the wrong device.
   - **Missing** — a drawn cable/device isn't there.
   - **Unexpected** — an extra cable/device the drawing doesn't have.
   - **Termination fault** — a port with media errors, half-duplex, or low speed.
   - **Ring open** — the ring isn't closed (with the two nodes bracketing the break).

   Green ⇔ every link matches the drawing-confirmed baseline **and** the ring is
   closed **and** terminations are clean.

## Safe by design (what it will and won't do)

- **On-demand only.** Nothing runs in the background. It reads switches **only**
  when you press Capture or Check. It never polls, never adds load, never lags
  the tool.
- **Read-only.** It only reads (SNMP GET/WALK + CIP Get_Attribute_Single). It
  writes nothing to any switch, device, or the PLC.
- **Fail-safe + isolated.** If SNMP isn't configured or a switch doesn't answer,
  the panel shows a plain "couldn't read — test on-site" message and **nothing
  else in the tool is affected**. The SNMP library is optional and loaded lazily;
  if it's absent the feature simply self-disables. It is a separate panel on the
  Network page with no shared state with the testing grid, sync, or PLC lifecycle.
- **Local.** The approved baseline is stored on the laptop and works offline.

## Setup (per site)

Add an SNMP block to `config.json` (absent/`enabled:false` → the feature is off):

```json
"snmp": { "enabled": true, "version": "v2c", "community": "public", "timeoutMs": 2000 }
```

Switch IPs come from the pulled network topology (`NetworkNodes`). The DLR ring
verdict uses the existing `dlrSupervisorPath` (or is derived from a `SLOTn_EN4TR`
device name).

## Status / limitations (honest)

- **Field-unverified.** Like the DLR ring-health badge, the live SNMP read path
  cannot be validated on the bench (the dev PLC is a Studio 5000 **Emulate 5580**
  — no real chassis, ring, or switches). The pure comparison logic is fully
  unit-tested and correct; the on-site read must be confirmed on real MTN6/CDW5
  hardware before the coloured results are trusted.
- **Moxa Turbo Ring** ring-state uses a **placeholder OID** until it is confirmed
  from the Moxa Industrial Protocols manual against real Moxa hardware. Until
  then the Moxa ring-state never reports a false "green" — LLDP/FDB port checks
  still work regardless of vendor.
- **Leaf-device (FDB) placement** needs a device MAC inventory to name devices;
  in this first version FDB placement stays empty (the switch↔switch LLDP port
  verification — the MTN6 check — is unaffected).
- It is **not core functionality**: the tool works fully without it. If it can't
  read on a given site, that's fine — fall back to the on-site check.
