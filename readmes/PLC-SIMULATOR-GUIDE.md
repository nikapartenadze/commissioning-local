# PLC Simulator - Testing Without Physical Hardware

## Overview

The PLC Simulator lets you test the IO Checkout Tool **without a physical PLC**! It simulates tag state changes so you can:
- Test the UI and workflow
- Develop features without hardware
- Demo the application
- Train users
- Test the diagnostic system

---

## How It Works

The simulator runs as a background service and:
1. Randomly changes I/O states (TRUE/FALSE)
2. Sends updates via SignalR (just like real PLC)
3. Triggers value change dialogs
4. Allows you to test pass/fail workflow
5. **Disabled by default** - you control when it runs

---

## Quick Start

### **Step 1: Start the Application**

```bash
cd backend
dotnet run
```

### **Step 2: Enable the Simulator**

**Via API (curl):**
```bash
curl -X POST http://localhost:5000/api/simulator/enable
```

**Via Browser:**
Open: `http://localhost:5000/api/simulator/enable` (POST request)

**Via Postman:**
- Method: POST
- URL: `http://localhost:5000/api/simulator/enable`

### **Step 3: Watch the Magic!**

Open the frontend (`http://localhost:3000`) and watch I/O states change automatically! 🎉

---

## API Endpoints

### **1. Enable Simulator**

```bash
POST /api/simulator/enable?intervalMs=2000
```

**Parameters:**
- `intervalMs` (optional): Update interval in milliseconds (500-10000)
  - Default: 2000ms (2 seconds)
  - Faster: 500ms (rapid testing)
  - Slower: 5000ms (demo mode)

**Example:**
```bash
# Enable with 1-second updates
curl -X POST "http://localhost:5000/api/simulator/enable?intervalMs=1000"
```

**Response:**
```json
{
  "message": "PLC Simulator enabled",
  "enabled": true,
  "intervalMs": 2000,
  "info": "Simulator will randomly change I/O states for testing"
}
```

---

### **2. Disable Simulator**

```bash
POST /api/simulator/disable
```

**Example:**
```bash
curl -X POST http://localhost:5000/api/simulator/disable
```

**Response:**
```json
{
  "message": "PLC Simulator disabled",
  "enabled": false
}
```

---

### **3. Check Status**

```bash
GET /api/simulator/status
```

**Example:**
```bash
curl http://localhost:5000/api/simulator/status
```

**Response:**
```json
{
  "enabled": true,
  "message": "Simulator is running"
}
```

---

### **4. Manual Trigger (Single I/O)**

Manually change a specific I/O state:

```bash
POST /api/simulator/trigger/{id}?state=TRUE
```

**Parameters:**
- `id`: I/O point ID
- `state`: "TRUE" or "FALSE"

**Example:**
```bash
# Set I/O #5 to TRUE
curl -X POST "http://localhost:5000/api/simulator/trigger/5?state=TRUE"

# Set I/O #5 to FALSE
curl -X POST "http://localhost:5000/api/simulator/trigger/5?state=FALSE"
```

**Response:**
```json
{
  "message": "I/O state changed to TRUE",
  "io": {
    "id": 5,
    "name": "Sensor_PE01",
    "state": "TRUE"
  }
}
```

---

### **5. Trigger All Inputs**

Set all untested inputs to TRUE at once:

```bash
POST /api/simulator/trigger-all-inputs
```

**Example:**
```bash
curl -X POST http://localhost:5000/api/simulator/trigger-all-inputs
```

**Response:**
```json
{
  "message": "Triggered 25 inputs to TRUE",
  "count": 25
}
```

**Use case:** Quickly test the pass/fail workflow on all inputs

---

### **6. Reset All States**

Set all I/O states back to FALSE:

```bash
POST /api/simulator/reset-all
```

**Example:**
```bash
curl -X POST http://localhost:5000/api/simulator/reset-all
```

**Response:**
```json
{
  "message": "Reset 50 I/O states to FALSE",
  "count": 50
}
```

**Use case:** Clean slate before starting a new test

---

### **7. Run Sequence**

Run a controlled sequence of state changes:

```bash
POST /api/simulator/run-sequence?count=10&delayMs=1000
```

**Parameters:**
- `count`: Number of I/O points to change (default: 10)
- `delayMs`: Delay between changes in milliseconds (default: 1000)

**Example:**
```bash
# Change 5 I/O points with 500ms delay
curl -X POST "http://localhost:5000/api/simulator/run-sequence?count=5&delayMs=500"
```

**Response:**
```json
{
  "message": "Ran sequence of 5 changes",
  "changes": [
    "Sensor_PE01 -> TRUE",
    "Button_Start -> FALSE",
    "Motor_Output -> TRUE",
    "Alarm_Input -> TRUE",
    "Green_Light -> FALSE"
  ]
}
```

**Use case:** Demo mode, training, controlled testing

---

## Usage Scenarios

### **Scenario 1: Development (No PLC Available)**

```bash
# Start simulator with fast updates
curl -X POST "http://localhost:5000/api/simulator/enable?intervalMs=1000"

# Develop and test features
# Watch I/O states change automatically

# Disable when done
curl -X POST http://localhost:5000/api/simulator/disable
```

---

### **Scenario 2: Demo/Training**

```bash
# Run a controlled sequence
curl -X POST "http://localhost:5000/api/simulator/run-sequence?count=10&delayMs=2000"

# Show how electricians mark pass/fail
# Show diagnostic system in action
```

---

### **Scenario 3: Testing Diagnostic System**

```bash
# Enable simulator
curl -X POST http://localhost:5000/api/simulator/enable

# Wait for I/O state changes
# Click "Fail" on changed I/O
# Select failure mode
# View diagnostic steps
# Test the complete workflow!
```

---

### **Scenario 4: Quick Pass/Fail Test**

```bash
# Trigger all inputs to TRUE
curl -X POST http://localhost:5000/api/simulator/trigger-all-inputs

# In UI: Mark them all as passed or failed
# Test bulk operations

# Reset when done
curl -X POST http://localhost:5000/api/simulator/reset-all
```

---

### **Scenario 5: Specific I/O Testing**

```bash
# Manually trigger specific I/O
curl -X POST "http://localhost:5000/api/simulator/trigger/5?state=TRUE"

# Test pass/fail on that specific I/O
# Verify dialog appears
# Test comments and failure modes

# Reset
curl -X POST "http://localhost:5000/api/simulator/trigger/5?state=FALSE"
```

---

## How the Simulator Works

### **Random Mode (Default):**
- Every 2 seconds (configurable)
- Selects 1-3 random untested I/O points
- Changes their states (bias towards TRUE for testing)
- Sends SignalR updates to all connected clients
- Skips already tested I/O points

### **Simulation Logic:**

**For Inputs:**
- 15% chance of state change per cycle
- 70% bias towards TRUE (easier to test)
- Simulates sensors, buttons, switches

**For Outputs:**
- 10% chance of activation per cycle
- Simulates motors, lights, valves

### **What It Doesn't Do:**
- ❌ Doesn't modify database (only in-memory state)
- ❌ Doesn't interfere with real PLC connection
- ❌ Doesn't change already tested I/O points
- ❌ Doesn't run by default (you must enable it)

---

## Integration with Real PLC

The simulator is **completely separate** from real PLC communication:

```
Real PLC Mode:
  PLC → libplctag → PlcCommunicationService → SignalR → Frontend

Simulator Mode:
  PlcSimulatorService → SignalR → Frontend
```

**You can:**
- ✅ Develop without PLC using simulator
- ✅ Switch to real PLC when available
- ✅ Use simulator for training/demo
- ✅ Keep simulator code in production (disabled by default)

**Important:**
- Simulator is disabled by default
- Enable it only when you don't have a PLC
- Disable it when connecting to real PLC
- No configuration needed - just API calls

---

## Tips & Best Practices

### **1. Development Workflow:**
```bash
# Start app
cd backend && dotnet run

# Enable simulator
curl -X POST http://localhost:5000/api/simulator/enable

# Develop features
# Test UI
# Test workflows

# Disable when connecting to real PLC
curl -X POST http://localhost:5000/api/simulator/disable
```

### **2. Demo Mode:**
```bash
# Slower updates for presentation
curl -X POST "http://localhost:5000/api/simulator/enable?intervalMs=3000"

# Or use controlled sequence
curl -X POST "http://localhost:5000/api/simulator/run-sequence?count=5&delayMs=2000"
```

### **3. Stress Testing:**
```bash
# Fast updates
curl -X POST "http://localhost:5000/api/simulator/enable?intervalMs=500"

# Test UI performance
# Test SignalR handling
# Test concurrent updates
```

### **4. Diagnostic System Testing:**
```bash
# Enable simulator
curl -X POST http://localhost:5000/api/simulator/enable

# Wait for state changes
# Click "Fail" on I/O
# Select failure mode
# View diagnostic steps
# Complete workflow test!
```

---

## Troubleshooting

### **Simulator not working?**

1. **Check if enabled:**
   ```bash
   curl http://localhost:5000/api/simulator/status
   ```

2. **Check backend logs:**
   Look for: `🎮 PLC Simulator ENABLED`

3. **Verify I/O points exist:**
   ```bash
   curl http://localhost:5000/api/ios
   ```

4. **Check SignalR connection:**
   Open browser console (F12) and look for SignalR messages

---

### **Not seeing state changes in UI?**

1. **Frontend connected to SignalR?**
   Check browser console for connection messages

2. **All I/O already tested?**
   Simulator skips tested points - clear results to test again

3. **Interval too slow?**
   Try faster updates:
   ```bash
   curl -X POST "http://localhost:5000/api/simulator/enable?intervalMs=1000"
   ```

---

## Summary

### **What You Get:**
✅ Test without physical PLC
✅ Simulate realistic I/O behavior
✅ Full control via API
✅ Safe (disabled by default)
✅ Perfect for development/demo/training

### **Quick Commands:**
```bash
# Enable
curl -X POST http://localhost:5000/api/simulator/enable

# Disable
curl -X POST http://localhost:5000/api/simulator/disable

# Status
curl http://localhost:5000/api/simulator/status

# Trigger specific I/O
curl -X POST "http://localhost:5000/api/simulator/trigger/5?state=TRUE"

# Trigger all inputs
curl -X POST http://localhost:5000/api/simulator/trigger-all-inputs

# Reset all
curl -X POST http://localhost:5000/api/simulator/reset-all
```

---

**Now you can test your application without a PLC!** 🎉

