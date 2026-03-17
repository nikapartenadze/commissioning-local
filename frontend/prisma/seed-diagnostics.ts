/**
 * Seed script for TagTypeDiagnostics table
 * Run: npx tsx prisma/seed-diagnostics.ts
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const diagnostics = [
  // ===== TPE Dark Operated =====
  {
    tagType: 'TPE Dark Operated',
    failureMode: 'No response',
    diagnosticSteps: `# TPE Dark Operated — No Response

## Quick Checks
1. Verify 24V power is present at the sensor terminals
2. Check the sensor indicator LED — it should be **OFF** in the normal (dark) state
3. Confirm wiring polarity: Brown = +24V, Blue = 0V, Black = Signal

## Wiring
- Disconnect the sensor cable at the device end
- Measure continuity from the sensor connector back to the IO module terminal
- Check for damaged or pinched cable along the run

## Sensor
- Verify the sensor is aimed correctly at the target area
- Clean the sensor lens — dust or debris can block the beam
- Check sensing distance — TPE sensors typically have 0.5–2m range
- Try swapping with a known-good sensor to isolate the issue

## IO Module
- Check the channel LED on the IO module — it should react when sensor state changes
- Verify the IO module is online (no fault LEDs)
- Check the slot/channel assignment matches the PLC program
`,
  },
  {
    tagType: 'TPE Dark Operated',
    failureMode: 'Stuck ON',
    diagnosticSteps: `# TPE Dark Operated — Stuck ON

The sensor is reporting active (beam blocked) but nothing is in the sensing area.

## Quick Checks
1. Check for obstructions in the beam path — debris, tape, misaligned brackets
2. Clean the sensor lens
3. Check the sensor indicator LED — if it's ON with no target, the sensor may be faulty

## Alignment
- Verify reflector (if retro-reflective) is aligned and clean
- Check mounting bracket — vibration may have shifted the sensor

## Electrical
- Measure signal wire voltage at the IO module terminal
- If voltage is present with sensor disconnected, check for a short in the cable
- Try a known-good sensor

## PLC Program
- Verify the tag is not inverted in the PLC logic
- Dark operated means the signal should be TRUE when beam is **blocked**, FALSE when clear
`,
  },
  {
    tagType: 'TPE Dark Operated',
    failureMode: 'Intermittent',
    diagnosticSteps: `# TPE Dark Operated — Intermittent

Signal is flickering or dropping out randomly.

## Quick Checks
1. Check all cable connections — loose connectors are the #1 cause
2. Look for cable damage — especially near moving parts or sharp edges
3. Check for electrical noise sources nearby (VFDs, welders, solenoids)

## Mechanical
- Tighten all mounting hardware — vibration causes intermittent connections
- Check the cable routing — avoid running parallel to power cables
- Verify the target is stable and not vibrating through the sensing area

## Electrical
- Wiggle the connector while monitoring the signal — if it drops, replace the cable
- Measure signal voltage under load — should be clean 0V or 24V, not floating
- Check grounding of the sensor shield wire
`,
  },
  {
    tagType: 'TPE Dark Operated',
    failureMode: 'Other',
    diagnosticSteps: `# TPE Dark Operated — Other Issue

If none of the standard failure modes apply:

1. Document the exact behavior you're observing
2. Note any patterns — does it happen at certain times, after certain events?
3. Check the PLC program for any logic that might override or mask the signal
4. Verify the tag type assignment is correct — is this actually a TPE Dark Operated device?
5. Escalate to engineering with your observations
`,
  },

  // ===== BCN 24V Segment 1 =====
  {
    tagType: 'BCN 24V Segment 1',
    failureMode: 'No response',
    diagnosticSteps: `# BCN 24V Segment 1 — No Response

Beacon stack bottom segment (24V hardwired) is not responding.

## Quick Checks
1. Visually confirm the beacon is not illuminated
2. Check 24V power at the beacon base terminal block
3. Verify the correct segment — Segment 1 is the **bottom** segment

## Wiring
- Check the terminal block connections at the base of the beacon stack
- Trace the wire from the IO module to the beacon — look for breaks or loose terminals
- Measure voltage at the beacon terminal while the output is commanded ON

## IO Module
- Verify the output channel LED on the IO module lights up when commanded
- Check if other outputs on the same module work — if none work, the module may be faulted
- Verify slot/channel matches PLC program

## Beacon
- If voltage is present at the beacon but no light, the segment bulb/LED may be burned out
- Try swapping segments to confirm — move segment 1 to segment 2 position
- Check the DIP switches on the **bottom** of segment 1
`,
  },
  {
    tagType: 'BCN 24V Segment 1',
    failureMode: 'Wrong color',
    diagnosticSteps: `# BCN 24V Segment 1 — Wrong Color

Beacon segment illuminates but shows the wrong color.

## Quick Checks
1. Verify which segment is physically installed in position 1 (bottom)
2. Check the DIP switch settings on the bottom of the segment — these control color on multi-color segments
3. Confirm the bill of materials matches what's installed

## DIP Switches (Bottom of Segment)
- Refer to the beacon manufacturer documentation for DIP switch color codes
- Common Patlite settings:
  - SW1=OFF, SW2=OFF → Red
  - SW1=ON, SW2=OFF → Amber
  - SW1=OFF, SW2=ON → Green
  - SW1=ON, SW2=ON → Blue

## Resolution
- Adjust DIP switches to the correct color
- Or swap the physical segment with the correct color module
`,
  },
  {
    tagType: 'BCN 24V Segment 1',
    failureMode: 'Other',
    diagnosticSteps: `# BCN 24V Segment 1 — Other Issue

1. Document the exact symptom (dim, flickering, wrong pattern, etc.)
2. Check all mechanical connections — beacon segments stack and twist-lock
3. Verify DIP switch positions on the bottom of the segment
4. Try the segment in a different position on the stack
5. Escalate if unresolved
`,
  },

  // ===== BCN I/O Link Segment 1 =====
  {
    tagType: 'BCN I/O Link Segment 1',
    failureMode: 'No response',
    diagnosticSteps: `# BCN I/O Link Segment 1 — No Response

Beacon stack bottom segment (IO-Link controlled) is not responding.

## Quick Checks
1. Check the IO-Link master port LED — should show active communication
2. Verify 24V power is present at the beacon base
3. Confirm the IO-Link master port is configured for the correct device profile

## IO-Link Communication
- Check the IO-Link master diagnostics in the PLC program
- Verify the port assignment and device ID match the beacon
- If the port shows "no device," check the M12 cable connection
- Try a different IO-Link port to isolate master vs device issue

## Wiring
- Inspect the M12 connector at both ends (IO-Link master and beacon)
- Check for bent pins in the M12 connector
- Try a known-good IO-Link cable

## Beacon
- IO-Link beacons require proper parameterization — verify the IO-Link master has sent the correct configuration
- Check if the beacon responds to a manual IO-Link port reset
`,
  },
  {
    tagType: 'BCN I/O Link Segment 1',
    failureMode: 'Communication error',
    diagnosticSteps: `# BCN I/O Link Segment 1 — Communication Error

IO-Link master reports communication issues with the beacon.

## Quick Checks
1. Check IO-Link master port diagnostics for specific error codes
2. Reseat the M12 connector at both ends
3. Check cable length — IO-Link max cable length is 20m

## Common IO-Link Errors
- **Port not configured**: Set the IO-Link master port to IO-Link mode (not SIO or DI)
- **Device mismatch**: The device ID doesn't match what the master expects — verify beacon model
- **Cable fault**: Try a different cable
- **Parameter error**: The beacon may need re-parameterization after replacement

## Resolution
- Reset the IO-Link port from the PLC program or web interface
- Re-download IO-Link parameters to the device
- If persistent, replace the beacon and re-parameterize
`,
  },
  {
    tagType: 'BCN I/O Link Segment 1',
    failureMode: 'Other',
    diagnosticSteps: `# BCN I/O Link Segment 1 — Other Issue

1. Check IO-Link master diagnostics for detailed error information
2. Verify the IO-Link device profile and parameters are correct
3. Document the exact behavior and any error codes
4. Escalate to controls engineering
`,
  },

  // ===== Button Press =====
  {
    tagType: 'Button Press',
    failureMode: 'No response',
    diagnosticSteps: `# Button Press — No Response

Pushbutton input does not register when pressed.

## Quick Checks
1. Press the button firmly — some buttons require deliberate force
2. Check the indicator LED on the IO module channel while pressing
3. Verify 24V is present at the button terminal

## Wiring
- Check terminal connections at the button and at the IO module
- Measure continuity through the button contacts (normally open)
- Press the button while measuring — resistance should drop to near 0Ω
- Check for broken wires, especially at flex points near the button

## Button
- Inspect the button mechanism — stuck, damaged, or contaminated contacts
- Try pressing from different angles — mechanical binding can prevent actuation
- Check if the button contact block is properly seated on the operator
- Try a known-good contact block

## IO Module
- If the LED doesn't light with a jumper wire across the input terminals, the module channel may be faulty
- Check module power and communication status
`,
  },
  {
    tagType: 'Button Press',
    failureMode: 'Stuck ON',
    diagnosticSteps: `# Button Press — Stuck ON

Input shows active without the button being pressed.

## Quick Checks
1. Check if the button is physically stuck in the pressed position
2. Disconnect the wire at the IO module — if signal clears, the issue is in the field wiring
3. If signal persists with wire disconnected, the IO module channel may be faulty

## Mechanical
- Clean around the button — debris can hold it in
- Check the contact block mounting — it may be misaligned and pressing the contacts
- Verify the correct contact block type (NO vs NC) matches the application

## Electrical
- Check for shorts in the cable — especially where wires run together
- Verify no other signal is back-feeding into this channel
`,
  },
  {
    tagType: 'Button Press',
    failureMode: 'Intermittent',
    diagnosticSteps: `# Button Press — Intermittent

Button sometimes registers, sometimes doesn't.

## Quick Checks
1. Tighten all terminal connections
2. Check the contact block seating on the button operator
3. Wiggle the cable while monitoring — intermittent = loose connection

## Common Causes
- Worn button contacts — replace the contact block
- Loose terminal screws — retorque
- Cable damage at flex point — reroute or replace
- Contaminated contacts — clean with contact cleaner
`,
  },
  {
    tagType: 'Button Press',
    failureMode: 'Other',
    diagnosticSteps: `# Button Press — Other Issue

1. Document the exact behavior
2. Check if the issue is mechanical (button) or electrical (wiring/module)
3. Verify the PLC program logic for this input
4. Escalate if unresolved
`,
  },

  // ===== Button Press Normally Closed =====
  {
    tagType: 'Button Press Normally Closed',
    failureMode: 'No response',
    diagnosticSteps: `# Button Press Normally Closed — No Response

NC pushbutton input does not change state when pressed.

**Important:** NC buttons read TRUE in the normal (unpressed) state and FALSE when pressed. Verify you're checking for the correct transition.

## Quick Checks
1. Confirm the current PLC state — it should be TRUE (1) when the button is NOT pressed
2. Press the button — the state should go FALSE (0)
3. If the state is already FALSE with the button released, check for an open circuit

## Wiring
- NC buttons must form a complete circuit in the normal state
- Measure voltage at the IO module — should be ~24V with button released, ~0V when pressed
- Check for an open circuit: broken wire, loose terminal, or bad contact block

## Button
- Verify the contact block is NC type (usually marked NC or has specific color coding)
- A common mistake is installing a NO contact block where NC is needed
- Check if the contact block is properly seated on the button operator

## PLC Program
- Verify the PLC logic expects NC behavior (inverted from NO buttons)
- An incorrect inversion in the program can make a working button appear broken
`,
  },
  {
    tagType: 'Button Press Normally Closed',
    failureMode: 'Stuck ON',
    diagnosticSteps: `# Button Press Normally Closed — Stuck ON

NC button always reads TRUE — pressing it doesn't change the state.

## Quick Checks
1. The normal state for NC IS true — verify you're actually pressing the button fully
2. Check the IO module LED — it should turn OFF when button is pressed
3. Disconnect the field wire at the IO module — input should go FALSE. If it stays TRUE, module issue.

## Mechanical
- Button may not be actuating the NC contact block — check alignment
- The contact block spring may be broken — replace the contact block
- Verify correct contact block type is installed (NC, not NO)

## Electrical
- Check if something else is feeding 24V to this input (back-feed)
- Measure voltage with button pressed — if still 24V, the NC contacts aren't opening
`,
  },
  {
    tagType: 'Button Press Normally Closed',
    failureMode: 'Other',
    diagnosticSteps: `# Button Press Normally Closed — Other Issue

1. Remember: NC buttons are TRUE when released, FALSE when pressed
2. Document the exact behavior vs expected behavior
3. Verify NC vs NO contact block installation
4. Check PLC logic for inversions
5. Escalate if unresolved
`,
  },

  // ===== Button Light =====
  {
    tagType: 'Button Light',
    failureMode: 'No response',
    diagnosticSteps: `# Button Light — No Response

Illuminated pushbutton light does not turn on when commanded.

## Quick Checks
1. Verify the PLC is commanding the output ON — check the output channel LED on the IO module
2. Check 24V power at the button light terminal
3. Confirm you're checking the correct button — the light is a separate output from the button press input

## Wiring
- The button light circuit is typically separate from the button contact circuit
- Trace the output wire from the IO module to the button light terminal
- Measure voltage at the button while the output is commanded ON
- Check for broken wires or loose terminals

## Button Light
- If 24V is present but no light, the LED/bulb in the button may be burned out
- Check if the light module is properly seated in the button operator
- Try a known-good light module
- Some illuminated buttons have separate LED modules that plug in — check the connection

## IO Module
- Verify the output channel is working — try commanding a different output on the same module
- Check module fault status
- Verify slot/channel assignment in PLC program
`,
  },
  {
    tagType: 'Button Light',
    failureMode: 'Stuck ON',
    diagnosticSteps: `# Button Light — Stuck ON

Button light stays illuminated when it should be off.

## Quick Checks
1. Verify the PLC is NOT commanding the output ON — check the output tag value
2. Check the IO module output LED — if it's OFF but the light is ON, there may be a back-feed

## Electrical
- Disconnect the output wire at the IO module — if the light stays on, 24V is coming from somewhere else
- Check for shorts between the output wire and adjacent 24V wires in the same cable
- Verify the output module type — some modules have leakage current that can illuminate LEDs

## PLC Program
- Check all logic that controls this output — another rung may be latching it ON
- Verify the correct tag address is being used
`,
  },
  {
    tagType: 'Button Light',
    failureMode: 'Wrong color',
    diagnosticSteps: `# Button Light — Wrong Color

Button illuminates but in the wrong color.

## Quick Checks
1. Verify which LED module is installed in the button
2. Check if this is a multi-color LED button — some have multiple inputs for different colors
3. Confirm the bill of materials for the correct LED color

## Resolution
- Replace the LED module with the correct color
- If multi-color, verify the PLC is commanding the correct output for the desired color
- Check if LED modules were swapped between buttons during installation
`,
  },
  {
    tagType: 'Button Light',
    failureMode: 'Intermittent',
    diagnosticSteps: `# Button Light — Intermittent

Button light flickers or turns on/off randomly.

## Quick Checks
1. Check if the PLC output is stable — monitor the tag value for fluctuations
2. Tighten all terminal connections
3. Check the LED module seating in the button

## Common Causes
- Loose LED module — reseat it firmly
- Loose terminal connection — retorque screws
- Overloaded output channel — check current draw vs module rating
- Failing LED module — replace
`,
  },
  {
    tagType: 'Button Light',
    failureMode: 'Other',
    diagnosticSteps: `# Button Light — Other Issue

1. Document the exact symptom (dim, wrong pattern, etc.)
2. Verify the output is being commanded correctly from the PLC
3. Check all connections from IO module to button
4. Try a known-good LED module
5. Escalate if unresolved
`,
  },
]

async function main() {
  console.log(`Seeding ${diagnostics.length} diagnostic entries...`)

  let count = 0
  for (const d of diagnostics) {
    await prisma.tagTypeDiagnostic.upsert({
      where: {
        tagType_failureMode: {
          tagType: d.tagType,
          failureMode: d.failureMode,
        },
      },
      create: {
        tagType: d.tagType,
        failureMode: d.failureMode,
        diagnosticSteps: d.diagnosticSteps,
        createdAt: new Date(),
      },
      update: {
        diagnosticSteps: d.diagnosticSteps,
        updatedAt: new Date(),
      },
    })
    count++
    console.log(`  [${count}/${diagnostics.length}] ${d.tagType} → ${d.failureMode}`)
  }

  console.log(`\nDone! Seeded ${count} diagnostic entries.`)
  console.log('\nTag types seeded:')
  const types = Array.from(new Set(diagnostics.map(d => d.tagType)))
  for (const t of types) {
    const modes = diagnostics.filter(d => d.tagType === t).map(d => d.failureMode)
    console.log(`  ${t}: ${modes.join(', ')}`)
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
