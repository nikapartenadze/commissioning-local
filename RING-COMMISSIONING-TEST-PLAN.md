# Network Comms Ring Commissioning — Field Test Plan

**Feature:** Ring Commissioning on the Network page of the commissioning tool.
**Purpose:** Verify the tool correctly (1) confirms switch-to-switch (DPM-to-DPM) cabling
matches the drawings **including the exact port**, (2) catches bad terminations via interface
speed and media counters, and (3) reports whether the ring is healthy.
**Use this document to test the feature once it has been implemented and installed.**

> Background: each DPM contains a Moxa managed switch; the DPM-to-DPM links form the ring. The
> tool reads each switch **directly over SNMP** (read-only) for neighbor topology (LLDP),
> port speed/error counters (IF-MIB), and ring status. Nothing is written to the switches or
> the PLC.

---

## Part A — Prerequisites

Do not start testing until **all** of these are true. Most failures during testing trace back
to a missed prerequisite here.

### A1. Site / hardware
- [ ] All DPMs in the ring are powered and fully booted.
- [ ] The ring is cabled per the current drawings (this is the configuration you are validating).
- [ ] You have a tablet/laptop running the commissioning tool, on a network that **can reach the
      switch management IPs** of every DPM (see A3 for how to confirm).

### A2. Moxa switch configuration (per DPM switch — set by the panel builder / network team)
- [ ] **SNMP is enabled**, version **v2c**.
- [ ] The **read-only community string** is known (Moxa default is `public`). Record it: ____________
- [ ] **LLDP is enabled** on the switches (Moxa default is on). Required for the topology check.
- [ ] *(Recommended)* Each switch's **system name (sysName)** is set to its DPM name
      (e.g. `NCP1_1_DPM1`). If not set, neighbors will show by MAC address instead of name — the
      check still works, but is harder to read and relies on the saved baseline's MAC map.
- [ ] *(Only if SNMP ring status is unavailable on this firmware)* **Modbus/TCP enabled** as the
      ring-status fallback. The tool will tell you if it needs this.

### A3. Tool / data
- [ ] The installed tool version includes the **Ring Commissioning** feature
      (visible on the Network page). Record version: ____________
- [ ] The correct **subsystem / ring data is loaded** (pulled from cloud or seeded): each DPM
      appears with its **correct management IP** in the network topology.
- [ ] Confirm reachability before testing. For each DPM IP, from the tablet:
      - [ ] `ping <switch-ip>` succeeds, **and**
      - [ ] if you have an SNMP tool handy, `snmpget -v2c -c <community> <switch-ip> sysName.0`
            returns a value. (Optional but the best pre-flight confirmation.)

### A4. Reference materials (needed for the baseline step)
- [ ] The **ring wiring drawing** for this subsystem, showing which physical port on each DPM
      connects to which port on its neighbor. You will check the first scan against this.
- [ ] The **expected link speed/duplex** for the ring uplinks (e.g. 100M-Full or 1G-Full) so you
      can judge the termination check.

### A5. Access
- [ ] You are logged into the tool as a user permitted to run commissioning checks and save a
      baseline.

### A6. Tool configuration (`config.json` → optional `ring` block)
All fields default sensibly; set only what your site needs. Lives beside the database
(`config.json`).
```jsonc
"ring": {
  "snmpCommunity": "public",        // your read community
  "snmpPort": 161,
  "snmpTimeoutMs": 3000,
  "snmpRetries": 1,
  "moxaOids": {                      // Moxa Turbo Ring private-MIB scalar OIDs (resolve per switch model)
    "protocol":   "1.3.6.1.4.1.8691...",
    "ringStatus": "1.3.6.1.4.1.8691...",
    "masterSlave":"1.3.6.1.4.1.8691..."
  },
  "ipOverrides": { "NCP1_1_DPM1": "10.0.0.5" },  // only if the switch mgmt IP ≠ the DPM IP
  "includeMcm": false,              // scan the MCM too (only if it answers SNMP)
  "modbus": {                       // ring-status fallback when SNMP doesn't expose it
    "enabled": false,               // set true to use Modbus for ring health
    "port": 502,
    "unitId": 1,
    "timeoutMs": 3000
  }
}
```
- [ ] Ring health resolves in this order: **SNMP `moxaOids` first; if that can't determine it
      and `modbus.enabled` is true, the tool reads the documented Moxa ring registers
      (0x3000/0x3300/0x3600) over Modbus/TCP.** Enable Modbus on the switches (A2) if you rely on
      this path.
- [ ] Community string matches the switches (A2).
- [ ] If ring health must be read over SNMP, `moxaOids` are filled in for this switch model.
      **Without them, ring health shows "unknown" but topology + termination checks still run.**
- [ ] **The MCM is not scanned by default** (it's a Rockwell module, not a Moxa switch). The
      DPM-to-DPM ring is what gets verified. Set `includeMcm: true` only if the MCM side answers
      SNMP.

---

## Part B — Pre-flight (inside the tool, before the formal test)

1. Open the **Network** page → **Ring Commissioning**.
2. Confirm the ring and all its DPMs are listed with the IPs from A3.
3. Note whether a **baseline already exists** for this ring:
   - **No baseline** → you will create one in Part C (normal for a first commissioning).
   - **Baseline exists** → Part C step 5 will compare against it. If the wiring has legitimately
     changed since, plan to re-save the baseline.

---

## Part C — Functional test (happy path)

### C1. First scan + create baseline
1. Press **Run Ring Check**.
2. **Expected:** every DPM switch shows **Reachable** (no "unreachable"). If any is unreachable,
   stop and resolve via Part F before continuing.
3. The tool displays the **actual** topology (neighbor + remote port for each ring link),
   ring health, and per-port speed/errors.
4. **Compare the displayed topology to the drawing (A4)**, link by link:
   - Each DPM connects to the neighbors shown on the drawing.
   - Each ring link uses the **exact ports** shown on the drawing.
5. If it matches the drawing, press **Save as expected baseline**.
   - **Expected:** baseline saved, with your user and a timestamp.
   - If it does **not** match the drawing, you have just caught a real wiring defect — log it,
     fix the cabling, and re-run from C1. **Do not save a baseline that disagrees with the
     drawing.**

### C2. Re-run and verify a clean pass
1. Press **Run Ring Check** again.
2. **Expected — all checks PASS:**
   | Check | Expected result |
   |---|---|
   | Reachability | All DPM switches reachable |
   | Ring health | Protocol as expected; ring **Healthy**; exactly one ring master; ring ports in expected forwarding/blocked states |
   | Topology vs baseline | Every link matches saved baseline (correct neighbor **and** correct remote port) |
   | Termination quality | Every ring port: link up, speed/duplex = expected, error counters clean (0 / not climbing) |
   | Overall | **PASS** banner |

---

## Part D — Fault-injection tests (prove the checks actually catch problems)

Run these on a ring where you can safely disturb cabling. **Restore the correct state and
confirm a PASS after each test.** Coordinate with anyone relying on the network first.

### D1. Ring break detection
1. Disconnect **one** ring cable between two DPMs (the ring should heal onto its redundant path —
   devices keep communicating).
2. **Run Ring Check.**
3. **Expected:** **Ring health = FAIL / broken-or-degraded**, identifying the affected
   link/DPMs. (This is the condition you previously could not see.)
4. Reconnect the cable, re-run, confirm **Ring health = PASS**.

### D2. Wrong-port miswire — the MTN6 case
1. Move **one** ring cable into the **wrong port** on a DPM where the ring will still form
   (e.g. a different valid uplink port than the drawing specifies).
2. **Run Ring Check.**
3. **Expected:** **Topology vs baseline = FAIL**, flagging **wrong remote port** on the affected
   link (and/or wrong neighbor), even though ring health may still read Healthy. This is the
   defect that "works but doesn't match the drawing."
4. Restore the correct port, re-run, confirm **Topology = PASS**.

### D3. Bad termination / speed mismatch
1. Introduce a degraded link — e.g. a known-bad/marginal patch cable on a ring port, or force a
   port to a lower speed if your test switch allows.
2. **Run Ring Check** (use the "re-scan after N seconds" / delta mode if offered, since error
   counters are cumulative).
3. **Expected:** **Termination quality = FAIL/WARN** on that port — speed/duplex below expected
   (e.g. negotiated 100M-Half instead of 1G-Full) and/or FCS/alignment/error counters present or
   climbing.
4. Restore a good cable, re-run, confirm **Termination = PASS**.

### D4. Switch unreachable
1. Disconnect one DPM switch's management reachability (or temporarily disable SNMP on it).
2. **Run Ring Check.**
3. **Expected:** that DPM reports **Unreachable**; the scan still completes for the others and
   does not crash.
4. Restore, re-run, confirm all **Reachable**.

---

## Part E — Pass / fail criteria (summary)

The feature is accepted when, on correctly-cabled rings:
- [ ] C2 produces an overall **PASS** with all four check categories passing.
- [ ] D1 detects a ring break.
- [ ] D2 detects a wrong-port miswire while the ring still forms (the MTN6 scenario).
- [ ] D3 flags a bad termination via speed and/or media counters.
- [ ] D4 reports an unreachable switch without failing the whole scan.
- [ ] Saving and re-comparing a baseline behaves as described (no false mismatches on an
      unchanged ring across repeated runs).

---

## Part F — Troubleshooting

| Symptom | Likely cause / action |
|---|---|
| DPM shows **Unreachable** | Tablet can't reach the switch management IP (A1/A3) — `ping` it; check VLAN/subnet/VPN. Or SNMP disabled / wrong community (A2). |
| All DPMs unreachable | Network/VLAN issue from the tablet, or community string wrong for the whole ring. Re-check A2/A3. |
| Topology shows **MAC addresses instead of DPM names** | Switch `sysName` not set (A2). Works via the baseline's MAC map, but set sysName for readability. |
| **Topology FAIL** but cabling looks right | Confirm the **baseline matches the current drawings**. If wiring legitimately changed, re-save the baseline (C1). |
| Ring health shows **"not enabled"** / unknown protocol | The switch's redundancy (Turbo Ring / RSTP / etc.) isn't configured, or the firmware doesn't expose ring state over SNMP — enable the **Modbus fallback** (A2) and re-run. |
| Error counters always non-zero on a known-good cable | Counters are cumulative since last reset; use the **delta / re-scan** mode and judge whether they are *climbing*, not just non-zero. |
| Speed reads lower than expected | Genuine bad termination, wrong cable category, or a forced port speed — inspect the physical link (this is the check working). |

---

## Part G — Result record

| Field | Value |
|---|---|
| Site / subsystem | |
| Ring name | |
| Tool version | |
| SNMP community used | |
| Tester | |
| Date / time | |
| C2 happy-path result (PASS/FAIL) | |
| D1 ring break detected? | |
| D2 wrong-port detected? | |
| D3 bad termination detected? | |
| D4 unreachable handled? | |
| Baseline saved (by / when) | |
| Notes / defects found | |
