-- Complete Import Script
-- This imports diagnostic guides AND sample I/O data
-- Run this in DBeaver to get everything set up at once!

-- ============================================
-- PART 1: DIAGNOSTIC GUIDES (9 entries)
-- ============================================

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
- Test adjacent inputs to verify card is working', datetime('now')),

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
- Route sensor cables away from power cables', datetime('now')),

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
- Verify input card is not faulty', datetime('now')),

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
- Verify button actuator moves freely', datetime('now')),

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
- Rewire to correct terminals', datetime('now')),

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
- Confirm output tag is being written', datetime('now')),

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
- Replace segment if defective', datetime('now')),

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
- Test continuity of circuit', datetime('now'));

-- ============================================
-- PART 2: SAMPLE I/O DATA (20 points)
-- ============================================

-- Note: SubsystemConfigurations is for storing PLC connection configs
-- We don't need to create one for testing - just use subsystem ID 999
-- The I/O points will be created directly

-- Add sample I/O points
-- Note: State column is not stored in database (it's real-time PLC data only)
INSERT INTO Ios (SubsystemId, Name, Description, TagType, Result, "Order") VALUES
-- Sensors (TPE Dark Operated)
(999, 'Conveyor_PE01', 'Product detection sensor at entry', 'TPE Dark Operated', NULL, 1),
(999, 'Conveyor_PE02', 'Product detection sensor at exit', 'TPE Dark Operated', NULL, 2),
(999, 'Position_Sensor_01', 'Position sensor station 1', 'TPE Dark Operated', NULL, 3),
(999, 'Position_Sensor_02', 'Position sensor station 2', 'TPE Dark Operated', NULL, 4),

-- Buttons (Button Press)
(999, 'Start_Button', 'Main conveyor start button', 'Button Press', NULL, 5),
(999, 'Stop_Button', 'Emergency stop button', 'Button Press', NULL, 6),
(999, 'Reset_Button', 'System reset button', 'Button Press', NULL, 7),
(999, 'Mode_Switch', 'Auto/Manual mode selector', 'Button Press', NULL, 8),

-- Beacon Lights (BCN 24V Segment 1)
(999, 'Green_Light', 'Status indicator - running', 'BCN 24V Segment 1', NULL, 9),
(999, 'Red_Light', 'Status indicator - fault', 'BCN 24V Segment 1', NULL, 10),
(999, 'Yellow_Light', 'Status indicator - warning', 'BCN 24V Segment 1', NULL, 11),
(999, 'Blue_Light', 'Status indicator - maintenance', 'BCN 24V Segment 1', NULL, 12),

-- Generic Inputs
(999, 'Alarm_Input_01', 'General alarm input', 'Generic Input', NULL, 13),
(999, 'Alarm_Input_02', 'Critical alarm input', 'Generic Input', NULL, 14),
(999, 'Limit_Switch_01', 'Upper limit switch', 'Generic Input', NULL, 15),
(999, 'Limit_Switch_02', 'Lower limit switch', 'Generic Input', NULL, 16),

-- Generic Outputs
(999, 'Motor_Output', 'Main conveyor motor', 'Generic Output', NULL, 17),
(999, 'Valve_Output_01', 'Pneumatic valve 1', 'Generic Output', NULL, 18),
(999, 'Valve_Output_02', 'Pneumatic valve 2', 'Generic Output', NULL, 19),
(999, 'Horn_Output', 'Warning horn', 'Generic Output', NULL, 20);

-- ============================================
-- VERIFICATION QUERIES
-- ============================================

-- Check what was imported
SELECT 'Diagnostic Guides' as Item, COUNT(*) as Count FROM TagTypeDiagnostics
UNION ALL
SELECT 'I/O Points', COUNT(*) FROM Ios
UNION ALL
SELECT 'Tagged I/Os', COUNT(*) FROM Ios WHERE TagType IS NOT NULL
UNION ALL
SELECT 'Test Subsystem I/Os', COUNT(*) FROM Ios WHERE SubsystemId = 999;

-- Show diagnostic coverage
SELECT 
    d.TagType,
    d.FailureMode,
    COUNT(io.Id) as IoCount
FROM TagTypeDiagnostics d
LEFT JOIN Ios io ON io.TagType = d.TagType
GROUP BY d.TagType, d.FailureMode
ORDER BY d.TagType, d.FailureMode;

-- Show I/O breakdown by type
SELECT TagType, COUNT(*) as Count 
FROM Ios 
WHERE TagType IS NOT NULL 
GROUP BY TagType
ORDER BY Count DESC;

