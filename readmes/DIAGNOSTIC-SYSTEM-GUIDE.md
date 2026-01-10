# Diagnostic System - User Guide

## Overview

The diagnostic system helps electricians troubleshoot failed I/O tests by providing step-by-step instructions based on the device type and failure mode.

---

## Features

### 1. **Tag Type Classification**
Each I/O point can be classified by device type:
- TPE Dark Operated (photoelectric sensors)
- BCN 24V Segment 1 (beacon lights)
- BCN I/O Link Segment 1 (IO-Link beacons)
- Button Press (normally open buttons)
- Button Press Normally Closed (NC buttons)
- Button Light (illuminated buttons)
- Generic Input/Output (catch-all)

### 2. **Failure Mode Selection**
When marking a test as failed, select WHY it failed:
- No response
- Intermittent
- Button stuck
- Communication fault
- Always shows pressed
- Light not working
- Other (with required comment)

### 3. **Guided Troubleshooting**
View step-by-step instructions for fixing the specific failure:
- Organized by steps
- Includes voltage checks
- Covers wiring verification
- Explains PLC diagnostics

---

## How to Use

### For Electricians:

#### **When a Test Fails:**

1. **Click "Fail" button** on the I/O point
2. **Dialog appears** with:
   - Tag name and description
   - Device type (if configured)
   - Failure mode dropdown
   - Comments field

3. **Select failure mode** from dropdown:
   - Choose the option that best describes the problem
   - If none match, select "Other" and explain in comments

4. **Click "Show Troubleshooting Steps"** (if available):
   - Opens detailed diagnostic guide
   - Follow steps in order
   - Use multimeter, visual inspection, etc.

5. **Fix the issue** following the steps

6. **Re-test the I/O point**:
   - If passes, mark as "Passed"
   - If still fails, try next troubleshooting step

#### **Example Workflow:**

```
Test fails: VFD01_TPE_Sensor_01
↓
Select: "No response"
↓
View troubleshooting steps:
  - Check power (24V)
  - Check beam alignment
  - Test sensor output
  - Check PLC input card
↓
Find issue: Loose wire at sensor terminal
↓
Fix: Tighten terminal connection
↓
Re-test: PASS! ✅
```

---

## For Administrators

### **Adding New Diagnostic Data**

#### **Method 1: Via API (Recommended)**

Use the bulk import endpoint to add multiple diagnostics:

```bash
# Create JSON file with diagnostic data
# diagnostics.json:
[
  {
    "tagType": "Proximity Sensor",
    "failureMode": "No response",
    "diagnosticSteps": "# Step 1: Check power\n- Verify voltage..."
  }
]

# Import via API
curl -X POST http://localhost:5000/api/diagnostics/import \
  -H "Content-Type: application/json" \
  -d @diagnostics.json
```

#### **Method 2: Direct Database Insert**

```sql
INSERT INTO TagTypeDiagnostics (TagType, FailureMode, DiagnosticSteps, CreatedAt) VALUES
('New Device Type', 'New Failure Mode', '# Troubleshooting Steps
## Step 1: First thing to check
- Detail 1
- Detail 2

## Step 2: Second thing to check
- More details...', datetime('now'));
```

#### **Method 3: Import from Spreadsheet**

1. Export spreadsheet to CSV format:
   ```csv
   TagType,FailureMode,DiagnosticSteps
   "Device Type","Failure Reason","# Step 1\n- Check this\n## Step 2\n- Check that"
   ```

2. Create import script or use API

### **Updating Existing Diagnostics**

```sql
UPDATE TagTypeDiagnostics 
SET DiagnosticSteps = '# Updated steps...', 
    UpdatedAt = datetime('now')
WHERE TagType = 'TPE Dark Operated' 
  AND FailureMode = 'No response';
```

### **Viewing All Diagnostics**

```bash
# Via API
curl http://localhost:5000/api/diagnostics/all

# Via SQL
SELECT TagType, FailureMode, 
       substr(DiagnosticSteps, 1, 50) as Preview
FROM TagTypeDiagnostics
ORDER BY TagType, FailureMode;
```

---

## Markdown Formatting

Diagnostic steps support basic Markdown:

```markdown
# Main Heading (Step title)
## Sub Heading (Sub-step)
### Minor Heading

**Bold text** for emphasis

- Bullet point 1
- Bullet point 2
  - Sub-bullet (indent with spaces)

Paragraphs separated by blank lines

Expected values: 24V DC ±10%
```

---

## Database Schema

### **TagTypeDiagnostics Table:**
```sql
CREATE TABLE TagTypeDiagnostics (
    TagType TEXT NOT NULL,           -- Device type classification
    FailureMode TEXT NOT NULL,       -- How it failed
    DiagnosticSteps TEXT NOT NULL,   -- Markdown troubleshooting steps
    CreatedAt TEXT NOT NULL,         -- When created
    UpdatedAt TEXT,                  -- Last updated
    PRIMARY KEY (TagType, FailureMode)
);
```

### **Ios Table (New Column):**
```sql
ALTER TABLE Ios ADD COLUMN TagType TEXT;
```

### **TestHistories Table (New Column):**
```sql
ALTER TABLE TestHistories ADD COLUMN FailureMode TEXT;
```

---

## API Endpoints

### **Get Tag Types:**
```
GET /api/diagnostics/tag-types
Returns: ["TPE Dark Operated", "Button Press", ...]
```

### **Get Failure Modes:**
```
GET /api/diagnostics/failure-modes?tagType=TPE%20Dark%20Operated
Returns: ["No response", "Intermittent", ...]
```

### **Get Diagnostic Steps:**
```
GET /api/diagnostics/steps?tagType=TPE%20Dark%20Operated&failureMode=No%20response
Returns: { "steps": "# Step 1...", "tagType": "...", "failureMode": "..." }
```

### **Get All Diagnostics:**
```
GET /api/diagnostics/all
Returns: [{ tagType, failureMode, diagnosticSteps, createdAt, updatedAt }, ...]
```

### **Create/Update Diagnostic:**
```
POST /api/diagnostics
Body: { "tagType": "...", "failureMode": "...", "diagnosticSteps": "..." }
```

### **Delete Diagnostic:**
```
DELETE /api/diagnostics?tagType=...&failureMode=...
```

### **Bulk Import:**
```
POST /api/diagnostics/import
Body: [{ tagType, failureMode, diagnosticSteps }, ...]
```

---

## Best Practices

### **Writing Diagnostic Steps:**

1. **Be Specific:**
   - ❌ "Check sensor"
   - ✅ "Use multimeter to verify 24V at sensor terminals 1 and 2"

2. **Include Expected Values:**
   - ❌ "Check voltage"
   - ✅ "Expected: 24V DC ±10% (21.6V - 26.4V)"

3. **Order by Likelihood:**
   - Start with most common issues
   - Progress to less common problems
   - End with "replace device" as last resort

4. **Include Safety Warnings:**
   ```markdown
   ## ⚠️ Safety Warning
   - De-energize circuit before working on wiring
   - Use proper PPE
   - Follow LOTO procedures
   ```

5. **Reference Tools Needed:**
   ```markdown
   ## Tools Required
   - Multimeter
   - Screwdriver set
   - Wire strippers
   ```

---

## Maintenance

### **Regular Updates:**
- Review failure data monthly
- Add new device types as encountered
- Update steps based on field experience
- Remove obsolete information

### **Quality Control:**
- Test diagnostic steps in the field
- Get feedback from electricians
- Verify technical accuracy
- Keep language clear and simple

---

## Sample Data Included

The system comes with diagnostic data for:
- ✅ TPE Dark Operated sensors (2 failure modes)
- ✅ Beacon 24V segments (1 failure mode)
- ✅ Beacon IO-Link segments (1 failure mode)
- ✅ Push buttons (2 failure modes)
- ✅ Button lights (1 failure mode)
- ✅ Generic inputs/outputs (2 failure modes)

**Total: 9 diagnostic entries covering common industrial devices**

---

## Future Enhancements

Potential additions:
- 📸 Add photos/diagrams to diagnostic steps
- 🎥 Link to video tutorials
- 📊 Track which diagnostics are most used
- 🤖 AI-suggested diagnostics based on failure patterns
- 🌐 Share diagnostic library across multiple sites

---

**Document Version:** 1.0  
**Last Updated:** January 2026  
**Feature:** Diagnostic System Implementation

