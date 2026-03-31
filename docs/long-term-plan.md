# Long-Term Vision: Digital Twin / Asset Traceability

*From conversation with Robert Yevdokimov, March 31, 2026*

## The Chain

```
Design → BOM → Purchase → Ship → Install → Commission → Operate → Maintain
```

Every step produces data the next step consumes. The IO checkout tool sits at the commissioning layer.

## Relationship Chain (Bottom-Up)

```
Project
  → Subsystem (MCM)
    → PLC
      → Network Ring (DLR loop)
        → Network Node (DPM)
          → Network Port (device slot)
            → Physical Device (VFD, FIOM, sensor, etc.)
              → Channel / IO Point (individual tag)
                → Test Result (pass/fail/history)
```

## Physical Extension (Future)

```
Physical Device
  → Part Number
    → Assembly / BOM
      → Purchase Order
        → Shipping / Delivery
          → Installation Location
            → 3D Model Reference
              → VR Visualization
```

## What This Enables

### Forward Tracing (Design → Field)
- Place device in design → add to BOM → create PO → ship → install → commission → monitor

### Reverse Tracing (Field → Design)
- Look up a specific part → trace its whole history: when ordered, when installed, when tested, current status

### Operational
- Is device physically installed? → Is it network connected? → Are its IOs working?
- Before testing IO, check parent device health (already partially implemented)
- Dual-channel sensor awareness — suppress SPARE dialog when paired channel fires (implemented)

### Guided Workflows
- Guided ordering: design knows what's needed → auto-generate POs
- Guided installation: installer sees what goes where
- Guided commissioning: tool knows what to test in what order based on dependencies

### Visualization
- 3D model with device references → VR headset → see virtual representation of system
- Overlay live PLC data on 3D model — see which devices are healthy/faulted in space

## Current State (What Exists)

### Implemented
- Project → Subsystem → IO (with test results, cloud sync)
- Network topology: Ring → DPM → Port (with live PLC status tags)
- EStop: Zone → EPC → IO Points / VFDs
- Safety: STO Bypass Zones → Drives
- Punchlist: Failed IO → Electrician workflow (Addressed/Clarification)
- `networkDeviceName` field on IO model (exists, needs population)
- SPARE IO handling with 500ms dual-channel suppression

### Next Steps
1. Populate `networkDeviceName` from IO connections CSV (TAGNAME column)
2. Block IO testing if parent device is faulted
3. Unified CSV import with device-IO relationship
4. Device detail view — click device, see all its IOs

### Foundation for Future
5. `Device` table — physical attributes (part number, type, install status, location)
6. Network ports and IOs reference Device records
7. "Show me everything about NCP1_8_VFD" — one query returns full chain
8. Installation status tracking — is it physically installed before testing?

## Key Principle

> "The database should be tying physical devices to IO points at some point in the future because we'll need to know things like was the device even physically installed before checking it." — Robert

The data model foundation — the chain of relationships from project down to IO point — is what makes everything else possible. Each layer we add enables the next.
