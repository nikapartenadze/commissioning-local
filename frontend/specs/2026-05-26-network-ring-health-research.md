# Network "Comms Ring" Health Check — Research & Design Notes

**Status:** research complete, not yet built. Resume point for the ring-health feature.
**Date:** 2026-05-26
**Related history:** the reverted `feat(network): Network Comms Ring Commissioning (v2.40.0)` (commit `b8bffb1`, reverted by `ac38f02`); the current network poller (`lib/plc/network/`); the SLOT5/6/7 exclusion (v2.39.5).

---

## Goal

Give commissioning a reliable **"is the comms ring healthy?"** indicator — meaning *the ring is closed and redundancy is intact*, not just *cables are plugged in*. The hard part is that a redundant ring keeps passing traffic when it breaks, so naive checks report green on a degraded ring.

## The network is TWO coupled rings, not one

The site mixes Rockwell DLR-capable modules **and** Hirschmann managed switches, which means a Device-Level-Ring (DLR) segment bridged into a Hirschmann MRP/HIPER-Ring backbone. They are different L2 redundancy protocols and **cannot share one ring** — they join through a DLR redundant gateway (Hirschmann Ring Coupling Protocol / RSTP uplink). A break in one ring is invisible to the other, so ring health needs **one verdict per ring**.

| Code name (our tool) | Real device | Ring role |
|---|---|---|
| `DPM` (we read up to 32 ports) | **Hirschmann Octopus OS30** managed switch | **Backbone ring** — MRP / HIPER-Ring, as Media Redundancy Manager (MRM) or Client (MRC) |
| `EN4TR` / `EN2TR` (e.g. `SLOT2_EN4TR`) | Rockwell 1756-EN2TR / 1756-EN4TR | **DLR ring supervisor** (2-port embedded switch, EtherNet/IP) |
| `FIOM` | **Murrelektronik Impact67** IO-Link master | DLR **ring node** (2-port, beacon-based; implements DLR object) |
| `SIO` | **Belden / Lumberg 0980 SSL** safety I/O | DLR **ring node** (dual M12 Ethernet, CIP Safety) |
| `VFD` | PowerFlex drives | Ring node **iff** dual-port Ethernet card; otherwise star off a switch port |
| `PMM` / `1420-V2-ENT`, `VSU`, `VR` | PowerMonitor, etc. | Usually **single-port → star** off an OS30 port (not in any ring) |

> `SLOT5/6/7` (`IB16` / `OB16E` / `IB16S`) are ControlLogix backplane I/O cards with **no Ethernet** — never ring devices. `SLOT2_EN4TR` is the real ring device. (This is why excluding SLOT5/6/7 from network readings in v2.39.5 was correct.)

## What we already measure — and why it's insufficient alone

The PLC ladder routine `IOCT_COMMUNICATION_MONITOR` MSG-collects the **CIP Ethernet Link Object (Class 0xF6)** per port into `UDT_NETWORK_NODE_DATA`; our poller (`lib/plc/network/poller.ts` + `parser.ts`, layout in `types.ts`) reads link-up + interface/media counters per port.

**The trap:** per-port link status **cannot** distinguish *closed ring* from *open-but-still-passing-traffic*. When a ring segment breaks, only the **two ports at the break** lose link; every other port still reads "up." So "all ring ports up" ≠ "ring healthy" — it reports green on a ring running with zero remaining redundancy. The protocol-level ring-state objects below are the only authoritative source.

## Health-check design (layered; protocol objects are the source of truth)

**Verdict: ring healthy = (DLR Network Status == Normal) AND (MRP ring == closed).** Per-port link is a corroboration / fault-localization layer, not the verdict.

### 1. DLR ring → CIP DLR Object (Class 0x47 / 71), read from the EN2TR/EN4TR supervisor
| Attr | Name | Use |
|---|---|---|
| **1** | Network Topology | `0 = Linear`, `1 = Ring`. If Linear → there is **no** DLR ring (redundancy lives only in the Hirschmann layer). Check this first. |
| **2** | Network Status | `0 = Normal` (closed/redundant), `1 = Ring Fault` (open/degraded), `2 = Unexpected Loop`, `3 = Partial Fault`, `4 = Rapid Fault/Restore` |
| 5 | Ring Fault Count | rising = intermittent flapping |
| 6 / 7 | Last Active Node on Port 1 / 2 | localizes the break to the two nodes bracketing it (IP + MAC) |
| 10 | Active Supervisor Address | which device owns the ring verdict |

Headline boolean = **Attr 1 == Ring AND Attr 2 == Normal**.
Read via CIP `Get_Attribute_Single` (0x0E) / `Get_Attributes_All` (0x01) to **Class 0x47, Instance 1**, targeting the EN2TR/EN4TR. (Logix has no DLR GSV — ring state always needs the explicit message.)

### 2. Hirschmann MRP backbone → SNMP only (the OS30 does NOT expose ring state over EtherNet/IP)
The OS30's CIP object set is Identity / TCP-IP / Ethernet Link + a proprietary **RSTP Bridge object (0x64)** and **RSTP Port object (0x65)** — **no DLR object, no MRP object.** A ControlLogix cannot MSG it for ring state. True signal is SNMP:
- **`hmMrpMRMRealRingState` = OID `1.3.6.1.4.1.248.14.5.3.1.25`** → `open(1)` / `closed(2)` / `undefined(3)` — read from the OS30 acting as MRM. (`closed` = redundancy intact.) *This is the single best MRP ring-health signal.*
- Supporting: `hmMrpMRMRealRoleState …3.1.24` (client/manager), `hmMrpRedOperState …3.1.27` (redGuaranteed / redNotGuaranteed). HIPER-Ring equivalents: `hmRingRedOperState …5.1.1.7`, `hmRingRedConfigOperState …5.1.1.9`.

### 3. Per-port link (already implemented, 0xF6) — corroboration + leaf coverage
Use to localize faults and to cover single-port/leaf devices the protocol objects don't surface. NOT the closed/open verdict.

## Implementation paths in our tool

- **DLR (0x47):**
  - (a) **Ladder-MSG path (most reliable):** add a MSG in `IOCT_COMMUNICATION_MONITOR` to copy `0x47` Attr 1/2/5/6/7 into a tag; extend `UDT_NETWORK_NODE_DATA` (or a new UDT) and the poller/parser to read it. Consistent with how 0xF6 is collected today. Requires a PLC program change.
  - (b) **Direct-CIP path (no ladder change):** have the poller issue a raw CIP read of `0x47` on the EN4TR via libplctag. Avoids touching the PLC program, but depends on libplctag raw-CIP support — **needs a spike to confirm feasibility.**
- **MRP (OS30):** new capability — an **SNMP poll** from the Node/Express side (e.g. `net-snmp`) to the OS30 MRM for `hmMrpMRMRealRingState`. No PLC involvement is possible. Needs SNMP enabled + community/v3 creds reachable from the field laptop.

## Open questions to confirm before building
1. Is the EN2TR/EN4TR actually a **DLR supervisor**, and which IP? → read `0x47` Attr 1 (Topology) + Attr 10 (Active Supervisor). If Topology=Linear, rethink (no DLR ring).
2. Is **SNMP enabled/reachable** on the OS30 from the field laptop (community string or v3)? If not, the backbone ring can only be proxied via per-port link.
3. Are the **VFD Ethernet cards dual-port (ring) or single-port (star)?** Affects which devices are ring nodes.

## Suggested next step
A tiny **spike**: read DLR `0x47` Attr 1 + Attr 2 off the EN4TR on the live PLC to (a) confirm it really is a DLR ring and (b) prove the read path (ladder-MSG vs direct libplctag CIP) before designing the full feature. Then brainstorm → spec → plan the "Ring Health" indicator.

## Reference material (provided by user + research)
- Rockwell **1756-UM004** ControlLogix chassis/controller manual (local: `Downloads\1756-um004_-en-p.pdf`; web: https://literature.rockwellautomation.com/idc/groups/literature/documents/um/1756-um004_-en-p.pdf). NOTE: chassis/controller reference — DLR ring specifics are NOT here; see ENET-AT007 / ENET-TD015 below.
- Hirschmann **Octopus OS30** (model `OS30-002404T6T6T5-TBBY999HHSE2S`).
- **Murrelektronik Impact67** IO-Link masters: https://shop.murrelektronik.com/en/I-O-Systems/Impact67/Modules/
- Rockwell **1420-V2-ENT** PowerMonitor: https://www.rockwellautomation.com/en-us/products/details.1420-V2-ENT.html
- Belden **0980 SSL** safety I/O: https://www.belden.com/products/i-o-systems/safety-i-o-modules/0980-ssl-3131-121-007d-202
- ODVA DLR Object attributes (HMS Anybus docs); TI ICSS DLR design (full attr table); ODVA **PUB00316R2** DLR Guidelines; Rockwell **ENET-AT007** DLR Application Technique; Rockwell **ENET-TD015** deploying DLR in CPwE.
- Hirschmann **HMRING-MGMT-SNMP-MIB** (OIDs above); Hirschmann Industrial Protocols UM (CIP objects 0x64/0x65); Hirschmann Redundancy Configuration UM (MRP / HIPER-Ring / RCP).

## Codebase anchors
- `lib/plc/network/types.ts` — `UDT_NETWORK_NODE_DATA` byte layout + Ethernet Link (0xF6) per-port model; `NETWORK_TAG_SUFFIXES`; `isExcludedRackSlot`. **No DLR (0x47) model yet.**
- `lib/plc/network/poller.ts` / `parser.ts` — where a DLR read would slot in alongside node polling.
- `components/network-diagnostics-view.tsx` — per-port diagnostics UI (Octopus = 32 ports, others = ring uplink ports 1–2).
- `lib/plc/connection-verdict.ts` — *PLC session* loss decision (NOT ring health; different concern — don't conflate).
