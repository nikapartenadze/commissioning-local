# DLR Ring Health Indicator — How It Works (for engineers)

*Plain-language explainer for the controls/commissioning team. Companion to the
technical notes in `2026-05-26-network-ring-health-research.md`.*

## What it shows

The Network Diagnostics page now has a small badge: **DLR Ring — Healthy / Degraded / Unknown**.

- **🟢 Healthy** — the Device-Level Ring is **closed** and redundancy is intact. If any single ring link or device drops, traffic re-routes the other way around the ring with no loss.
- **🔴 Degraded** — the ring is **open** (a break, a misconfiguration, or flapping). Data may still be flowing on a single path, but **there is no redundancy left** — the next break could drop devices. The badge shows the reason (Ring Fault, Unexpected Loop, Partial Fault, Rapid Fault/Restore).
- **⚪ Unknown** — we could not read a DLR ring (no DLR-capable supervisor answered, the controller is an emulator, or the path isn't configured). **The badge never shows Healthy unless the ring hardware actually confirms it.**

## What "the ring" is here

This site has **two** redundant rings:

1. **The Rockwell DLR ring** — the 1756-**EN2TR/EN4TR** Ethernet module (the ring "supervisor") plus the DLR-capable nodes daisy-chained on it (Murr Impact67 IO-Link masters, Belden 0980 safety I/O, dual-port drives). This is a **Device-Level Ring (DLR)**, an EtherNet/IP standard.
2. **The Hirschmann "DPM" backbone ring** — the Octopus OS30 managed switches, running **MRP / HIPER-Ring**.

**This indicator covers ring #1 (the Rockwell DLR ring) only.** Ring #2 (the Hirschmann backbone) uses a different protocol whose status is only available over SNMP, not EtherNet/IP — that's a planned Phase 2. So a fault *purely* inside the Hirschmann backbone will not yet light this badge.

## How it reads the ring (and why it's safe)

Every EN2TR/EN4TR keeps a standard CIP object — the **DLR Object, Class 0x47** — that reports the live ring state. The tool reads four attributes from the supervisor:

| Attribute | Meaning | Used for |
|---|---|---|
| **Attr 1 — Network Topology** | 0 = Linear, **1 = Ring** | Is it even wired/configured as a ring? |
| **Attr 2 — Network Status** | **0 = Normal**, 1 = Ring Fault, 2 = Unexpected Loop, 3 = Partial Fault, 4 = Rapid Fault/Restore | The healthy/degraded verdict |
| **Attr 5 — Ring Fault Count** | faults since power-up | Spot intermittent/flapping rings |
| **Attr 8 — Ring Participants** | number of nodes in the ring | Sanity-check device count |

The verdict is simply: **Topology = Ring AND Network Status = Normal → Healthy.** Anything else → Degraded (if it's a ring) or Unknown (if it isn't / didn't answer).

**It is strictly read-only.** The tool uses the CIP service **`Get_Attribute_Single` (0x0E)** — a *read* service. It does not write tags, change I/O, alter configuration, or affect the PLC program or the ring in any way. It's the same kind of query Studio 5000's "Ring Statistics" page makes.

The read runs once per network-poll cycle (default every 60 s). While the ring is readable it's checked every cycle, so a break is caught within one cycle; when no DLR ring is present it backs off to avoid wasted traffic.

## Setup (per site)

The tool addresses the EN4TR by its **chassis slot**. By default it auto-detects this from the device naming (`SLOT2_EN4TR` → backplane slot 2). If your EN4TR isn't named that way or sits elsewhere, set one line in the tool's `config.json`:

```json
"dlrSupervisorPath": "1,2"   // backplane port 1, slot <EN4TR slot>
```

## Current status / limitations

- **Phase 1 = Rockwell DLR ring only.** The Hirschmann/DPM backbone ring (MRP, via SNMP) is not covered yet.
- **Field verification pending.** It was developed against a Studio 5000 **Emulate** controller, which has no physical ring — so on the bench the badge correctly reads **Unknown**. The Healthy/Degraded logic follows the ODVA DLR specification and the read mechanism is proven, but the colored states should be confirmed once on real hardware (unplug a ring cable → expect Degraded → Ring Fault; reconnect → Healthy).
