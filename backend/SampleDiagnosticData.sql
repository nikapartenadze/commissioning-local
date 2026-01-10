-- Sample Diagnostic Data for IO Checkout Tool
-- This file contains troubleshooting steps for common industrial I/O devices
-- Run this against your SQLite database to populate diagnostic information

-- TPE (Through-beam Photoelectric) Sensors
INSERT OR REPLACE INTO TagTypeDiagnostics (TagType, FailureMode, DiagnosticSteps, CreatedAt) VALUES
('TPE Dark Operated', 'No response', '# Troubleshooting TPE Dark Operated Sensor - No Response

## Step 1: Check Power Supply
- Verify 24V DC power at sensor terminals
- Expected voltage: 24V DC ±10% (21.6V - 26.4V)
- Use multimeter to measure voltage
- Check for loose connections

## Step 2: Verify Beam Alignment
- Ensure transmitter and receiver are properly aligned
- Check for obstructions in beam path
- Clean sensor lenses (dust/dirt can block beam)
- Verify mounting brackets are secure

## Step 3: Check Wiring
- Inspect all wire connections for tightness
- Look for damaged or cut cables
- Verify wire colors match wiring diagram
- Check for proper shielding on cables

## Step 4: Test Sensor Output
- Use multimeter to test sensor output signal
- Dark operated: Should output signal when beam is BLOCKED
- Expected: 24V when blocked, 0V when clear
- If no output, sensor may be faulty

## Step 5: Check PLC Input Card
- Verify input card LED indicator
- LED should light when sensor activates
- Check input card fuse
- Test adjacent inputs to verify card is working

## Step 6: Verify PLC Tag
- Confirm tag name matches PLC program
- Check tag is mapped to correct input address
- Verify no typos in tag name', datetime('now')),

('TPE Dark Operated', 'Intermittent', '# Troubleshooting TPE Dark Operated Sensor - Intermittent Operation

## Step 1: Check Beam Alignment
- Sensor may be on edge of detection range
- Adjust alignment for stronger signal
- Ensure mounting is rigid (no vibration)

## Step 2: Inspect Wiring Connections
- Look for loose terminal connections
- Check for intermittent wire breaks
- Wiggle wires while monitoring output
- Re-terminate any suspect connections

## Step 3: Check for Interference
- Look for nearby sources of electrical noise
- Check if issue occurs when specific equipment runs
- Verify proper cable shielding
- Route sensor cables away from power cables

## Step 4: Test Sensor Sensitivity
- Clean sensor lenses thoroughly
- Check if ambient light is interfering
- Adjust sensor sensitivity if available
- Consider replacing sensor if worn', datetime('now')),

-- Beacon Stack Segments
('BCN 24V Segment 1', 'No light', '# Troubleshooting Beacon 24V Segment - No Light

## Step 1: Check Power to Beacon
- Verify 24V power at beacon base
- Check main beacon power supply
- Look for blown fuses in power circuit

## Step 2: Check Segment Wiring
- Verify wiring to Segment 1 specifically
- Check DIP switch settings on segment
- Ensure segment is properly seated in stack

## Step 3: Test Bulb/LED
- Remove segment from stack
- Apply 24V directly to segment terminals
- If no light, bulb/LED module is faulty
- Replace segment if defective

## Step 4: Check PLC Output
- Verify PLC output card is energized
- Check output card LED indicator
- Test output with multimeter (should show 24V)
- Verify output tag is being written correctly', datetime('now')),

('BCN I/O Link Segment 1', 'Communication fault', '# Troubleshooting Beacon IO-Link Segment - Communication Fault

## Step 1: Check IO-Link Master Status
- Verify IO-Link master has power
- Check master status LEDs
- Confirm master is communicating with PLC

## Step 2: Check Segment Connection
- Verify M12 connector is fully seated
- Check for bent pins in connector
- Ensure cable is not damaged
- Try reseating the connection

## Step 3: Verify IO-Link Configuration
- Check IO-Link device ID matches configuration
- Verify port number is correct
- Confirm device is configured in PLC program
- Check IO-Link master port status

## Step 4: Test with Different Port
- Try connecting segment to different IO-Link port
- If works on different port, original port may be faulty
- Check master documentation for port diagnostics', datetime('now')),

-- Push Buttons
('Button Press', 'Button stuck', '# Troubleshooting Push Button - Button Stuck

## Step 1: Physical Inspection
- Check if button is mechanically stuck
- Look for debris or damage around button
- Press and release button several times
- Verify button returns to normal position

## Step 2: Check Button Contacts
- Use multimeter to test contact continuity
- Contacts should be OPEN when not pressed
- Contacts should be CLOSED when pressed
- If contacts don''t change, button mechanism is faulty

## Step 3: Check for Mechanical Binding
- Remove button from panel if possible
- Inspect mounting hardware
- Look for overtightened mounting nuts
- Verify button actuator moves freely

## Step 4: Replace Button
- If mechanically stuck and cannot be freed
- Replace with identical button
- Verify new button operates smoothly
- Test electrical continuity after installation', datetime('now')),

('Button Press', 'No response', '# Troubleshooting Push Button - No Response

## Step 1: Test Button Contacts
- Use multimeter to test continuity
- Press button and verify contacts close
- If no continuity change, button is faulty

## Step 2: Check Wiring
- Verify wires are connected to button terminals
- Check for loose or broken wires
- Trace wiring back to input card
- Verify wire numbers match drawings

## Step 3: Check PLC Input
- Verify input card receives signal
- Check input card LED when button pressed
- Test with multimeter at input terminals
- Verify input card is not faulty

## Step 4: Verify PLC Configuration
- Confirm input tag is configured correctly
- Check tag address matches physical input
- Verify no force conditions on tag
- Test tag in PLC program', datetime('now')),

('Button Press Normally Closed', 'Always shows pressed', '# Troubleshooting NC Button - Always Shows Pressed

## Step 1: Verify Button Type
- Confirm button is actually Normally Closed (NC)
- NC buttons should show pressed when NOT activated
- Check button markings or part number

## Step 2: Check Wiring
- NC buttons are wired differently than NO buttons
- Verify common and NC terminals are used
- Check wiring matches electrical drawings
- Ensure wires are not swapped

## Step 3: Test Button Operation
- Use multimeter on button contacts
- NC contacts: CLOSED when not pressed, OPEN when pressed
- If backwards, button may be wired to NO contacts
- Rewire to correct terminals

## Step 4: Check PLC Logic
- Verify PLC program expects NC logic
- May need to invert logic in PLC code
- Check if NOT instruction is used
- Confirm expected behavior with programmer', datetime('now')),

-- Button Lights
('Button Light', 'Light not working', '# Troubleshooting Button Light - Not Working

## Step 1: Check Power to Light
- Verify 24V power to light circuit
- Use multimeter at light terminals
- Check if power is switched by PLC output

## Step 2: Test Bulb/LED
- Remove button from panel
- Apply 24V directly to light terminals
- If no light, bulb/LED is burned out
- Replace bulb or LED module

## Step 3: Check PLC Output
- Verify PLC output is energized
- Check output card LED indicator
- Test output voltage with multimeter
- Confirm output tag is being written

## Step 4: Check Wiring
- Trace wiring from output card to button
- Look for broken or disconnected wires
- Verify wire numbers match drawings
- Check for proper polarity (+ and -)

## Step 5: Verify Button Assembly
- Some buttons have separate light modules
- Check if light module is properly installed
- Verify light socket contacts are clean
- Ensure bulb is fully seated in socket', datetime('now')),

-- Generic/Other
('Generic Input', 'No response', '# Troubleshooting Generic Input - No Response

## Step 1: Verify Power
- Check 24V power supply to device
- Measure voltage at device terminals
- Verify power supply is adequate for load

## Step 2: Check Device Operation
- Test device manually if possible
- Verify device is not mechanically stuck
- Check for physical damage

## Step 3: Test Wiring
- Check all wire connections
- Look for damaged cables
- Verify wire routing is correct
- Test continuity from device to PLC

## Step 4: Check PLC Input
- Verify input card is receiving signal
- Check input card status LEDs
- Test with known good device
- Verify input card is not faulty', datetime('now')),

('Generic Output', 'No activation', '# Troubleshooting Generic Output - No Activation

## Step 1: Verify PLC Output
- Check if PLC output is energized
- Verify output card LED indicator
- Use multimeter to test output voltage
- Should read 24V when activated

## Step 2: Check Output Device
- Verify device is receiving power/signal
- Test device with direct power if possible
- Check for mechanical binding
- Look for physical damage

## Step 3: Inspect Wiring
- Check all connections from output card to device
- Look for broken or loose wires
- Verify correct polarity
- Test continuity of circuit

## Step 4: Check Device Load
- Verify device current draw is within output card rating
- Check if output card is overloaded
- Look for short circuits
- Test with known good output card', datetime('now'));

-- Add more as needed...

