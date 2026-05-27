# Ring Health Indicator — How It Works (for engineers)

*Plain-language explainer for the controls/commissioning team. Companion to the
technical notes in `2026-05-26-network-ring-health-research.md`.*

## What it shows

The Network Diagnostics page header has a **Ring** badge: **Healthy / Degraded / Unknown**, driven by the **EN4TR acting as the DLR ring supervisor**.

- **🟢 Healthy** — the ring is **closed** (Topology = Ring, Network Status = Normal). Redundancy is intact: a single link or device drop re-routes the other way with no loss.
- **🔴 Degraded** — the supervisor reports a **Ring Fault** (or other non-normal state). The badge shows the reason and, when the supervisor provides it, **where the break is** — "between `<node A>` and `<node B>`".
- **⚪ Unknown** — no DLR supervisor answered (no DLR object, timeout, or Topology = Linear). **The badge never shows Healthy unless the supervisor confirms a closed ring.**

## Why this is the right source (the key point)

The **EN4TR is the DLR ring supervisor.** A DLR supervisor continuously sends beacons around the ring; the moment a link breaks, beacons stop completing the loop, the supervisor declares a **Ring Fault**, and it records the **last active node on each of its two ring ports** — i.e. the two devices bracketing the break.

The Hirschmann Octopus (**"DPM"**) switches **cannot report their ring state over EtherNet/IP** (that lives only in their SNMP MRP data). **But they don't need to:** if the DPM switches sit on the DLR ring, then a break *between* two of them stops the supervisor's beacons just the same — so the **EN4TR sees it**. As the engineer put it: *what the DPMs don't do, the EN4TR does.*

So there is **one authoritative source of ring health — the EN4TR's DLR object** — and that's exactly what the badge reads. (An earlier per-port "DPM ring" heuristic was removed; the supervisor view supersedes it and is more reliable.)

## "Does it tell me the 5 DPMs are connected healthy?"

**Yes — if the DPM switches are participants on the DLR ring the EN4TR supervises.** A break between any two of them → the EN4TR reports **Ring Fault**, and the **Last Active Node on Port 1/Port 2** values name the two nodes on either side of the break, so you know *where*. The **Ring Participants count** (Attr 8) shows how many nodes the supervisor sees — confirm on-site that it includes all the DPMs.

> If the DPMs turn out to sit on a *separate* Hirschmann-only MRP ring (not the EN4TR's DLR ring), the EN4TR would not see those breaks — in that case we add an SNMP read of the OS30 MRP manager (`hmMrpMRMRealRingState`), which needs the OS30 management IPs + SNMP community. Confirm which it is using the Participants list on real hardware.

## What we read (and why it's safe)

The EN4TR keeps a standard CIP object — the **DLR Object, Class 0x47** — reporting live ring state. The tool reads, **read-only**:

| Attribute | Meaning | Used for |
|---|---|---|
| **Attr 1 — Network Topology** | 0 = Linear, **1 = Ring** | Is it wired/configured as a ring? |
| **Attr 2 — Network Status** | **0 = Normal**, 1 = Ring Fault, 2 = Unexpected Loop, 3 = Partial Fault, 4 = Rapid Fault/Restore | The Healthy/Degraded verdict |
| **Attr 6 / 7 — Last Active Node, Port 1 / 2** | IP of the node each side of the break | **Where** the ring opened |
| **Attr 5 — Ring Fault Count** | faults since power-up | Intermittent/flapping detection |
| **Attr 8 — Ring Participants** | nodes in the ring | Confirm the DPMs are on the ring |

Verdict: **Topology = Ring AND Network Status = Normal → Healthy.** It uses the CIP service **`Get_Attribute_Single` (0x0E)** — a *read*. It writes nothing: no tags, no I/O, no configuration, no effect on the PLC or the ring. Same kind of query as Studio 5000's "Ring Statistics" page. The read runs once per network-poll cycle (default 60 s); while the ring is readable it's checked every cycle, so a break is caught within one cycle.

## Setup (per site)

The tool reaches the EN4TR by its chassis slot. By default it auto-detects from the device naming (`SLOT2_EN4TR` → backplane slot 2). If the EN4TR isn't named that way or sits elsewhere, set one line in `config.json`:

```json
"dlrSupervisorPath": "1,2"   // backplane port 1, slot <EN4TR slot>
```

## Status / limitations

- **Field-unverified.** Developed against a Studio 5000 **Emulate 5580** controller, which has no physical chassis/ring — so on the bench the badge correctly reads **Unknown**. The logic follows the ODVA DLR spec and the read is proven, but the colored states must be confirmed on real hardware: unplug a ring cable → **Degraded · Ring Fault · between X and Y**; reconnect → **Healthy**.
- **Break-location IP byte order** is best-effort (the bench can't confirm it). If the "between X and Y" IPs show reversed on real hardware, it's a one-line fix.
- **DPM coverage** depends on the DPMs being DLR ring participants (see the section above).
