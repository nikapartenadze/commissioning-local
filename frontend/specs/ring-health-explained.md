# DLR Ring Health Indicator — How It Works (for engineers)

*Plain-language explainer for the controls/commissioning team. Companion to the
technical notes in `2026-05-26-network-ring-health-research.md`.*

## What it shows

The Network Diagnostics page header now has **two** ring badges:

- **DPM Ring** — health of the Hirschmann Octopus (OS30) switch ring (the "DPM" devices).
- **DLR Ring** — health of the Rockwell Device-Level Ring (the EN4TR + its nodes).

Each reads **Healthy / Degraded / Unknown**. They use different sources because the two rings run different protocols (details below).

### The DLR Ring badge

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

## The DPM Ring badge — how it reads the Hirschmann ring

The Hirschmann OS30 switches do **not** expose their ring (MRP) state over EtherNet/IP — only over SNMP. So instead of asking the switch "is the ring closed?", the **DPM Ring** badge uses the **per-port link data we already collect for every DPM switch** (the same `*_NN` data the PLC gathers and we poll):

- For each DPM (OS30) switch, it looks at every port that **was carrying traffic and then lost link** (a real, in-use link that went down — e.g. a pulled or broken ring cable), and any port reporting a **hardware fault**.
- **🟢 Healthy** — DPM switches seen, all their in-use links up, no faults.
- **🔴 Degraded** — a DPM switch has an in-use port that dropped link, or a hardware fault (the badge names the switch + port).
- **⚪ Unknown** — no DPM switch data yet.

Unused spare ports (never carried traffic) are ignored, so they don't false-alarm.

**What this catches:** the common, important case — a **physically broken ring link / down ring port** on a Hirschmann switch. **What it does not catch (yet):** the *logical* MRP redundancy state ("ring closed vs open but still passing traffic"), which only the switch's MRP manager knows and is only readable over **SNMP** (`hmMrpMRMRealRingState`). Adding that is a planned refinement — it needs the OS30 management IPs + SNMP community string, and on-site access (the dev bench has no real switches). Until then, the DPM Ring badge is a **link-level** health view, which still flags a broken ring segment.

## Setup (per site)

The tool addresses the EN4TR by its **chassis slot**. By default it auto-detects this from the device naming (`SLOT2_EN4TR` → backplane slot 2). If your EN4TR isn't named that way or sits elsewhere, set one line in the tool's `config.json`:

```json
"dlrSupervisorPath": "1,2"   // backplane port 1, slot <EN4TR slot>
```

## Current status / limitations

- **DLR Ring** — full ODVA DLR state, read-only over CIP. **DPM Ring** — link-level health from per-port data (catches a broken/down ring link or a switch hardware fault); the *logical* MRP redundancy state (via SNMP) is a planned refinement.
- **Field verification pending.** Developed against a Studio 5000 **Emulate** controller, which has no physical chassis/ring — so on the bench the DLR badge reads **Unknown** and the DPM badge reflects only emulated per-port data. The logic is sound (DLR follows the ODVA spec; DPM uses real link semantics) but the colored states should be confirmed on real hardware: unplug a DPM ring cable → **DPM Ring → Degraded**; unplug a DLR ring cable → **DLR Ring → Degraded (Ring Fault)**; reconnect → **Healthy**.
