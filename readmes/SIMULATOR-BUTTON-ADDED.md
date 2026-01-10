# ✅ Simulator Button Added to UI!

## What Was Implemented

Added a **Simulator Control Button** to the toolbar that:
- ✅ Only shows for **Admin users**
- ✅ Toggles simulator on/off with one click
- ✅ Shows current status (ON/OFF)
- ✅ Purple color when active
- ✅ Checks simulator status on page load

---

## How to Use

### **1. Login as Admin**

- PIN: `1234`
- User: Admin

### **2. Go to Commissioning Page**

You'll see a new **"Simulator"** button in the toolbar (right side, before PLC status icons).

### **3. Click to Enable**

- Button shows: **"Simulator"** (outline style)
- Click it
- Button changes to: **"Simulator ON"** (purple background)
- Simulator starts changing I/O states automatically!

### **4. Click Again to Disable**

- Button shows: **"Simulator ON"** (purple)
- Click it
- Button changes back to: **"Simulator"** (outline)
- Simulator stops

---

## PowerShell Command Fix

For PowerShell, use:

```powershell
# Enable simulator
Invoke-WebRequest -Uri http://localhost:5000/api/simulator/enable -Method POST

# Or short form
iwr -Uri http://localhost:5000/api/simulator/enable -Method POST

# Disable simulator
iwr -Uri http://localhost:5000/api/simulator/disable -Method POST

# Check status
iwr -Uri http://localhost:5000/api/simulator/status
```

---

## Button Location

```
Toolbar Layout:
[START TESTING] [Graph] [Export] [History] ... [Simulator] [PLC Status] [Cloud Status]
                                                    ↑
                                              New button here!
                                              (Admin only)
```

---

## Features

### **Admin Only:**
- Only users with `isAdmin: true` can see the button
- Regular users won't see it at all

### **Visual Feedback:**
- **OFF:** Outline button with lightning icon
- **ON:** Purple button with "Simulator ON" text
- Clear visual indicator of current state

### **Smart Status:**
- Checks simulator status when page loads
- Shows correct state even after page refresh
- Updates immediately when clicked

---

## Testing Steps

### **1. Make sure subsystem ID is 999:**

Edit `backend/config.json`:

```json
{
  "subsystemId": "999",
  "remoteUrl": ""
}
```

### **2. Start the app:**

```powershell
# Backend
cd backend
dotnet run

# Frontend (new terminal)
cd frontend
npm run dev
```

### **3. Open browser:**

```
http://localhost:3000
```

### **4. Login as Admin:**

- PIN: `1234`

### **5. Go to commissioning page**

### **6. Click the "Simulator" button!**

You should see:
- Button turns purple
- Shows "Simulator ON"
- I/O states start changing automatically
- Value change dialogs appear

---

## Troubleshooting

### **"Don't see the Simulator button"**

Check:
- ✅ Logged in as Admin? (PIN: 1234)
- ✅ On commissioning page?
- ✅ Backend running?

### **"Button doesn't work"**

Check:
- ✅ Backend running on port 5000?
- ✅ Check browser console for errors (F12)
- ✅ Try the PowerShell command to verify API works

### **"Simulator ON but no state changes"**

Check:
- ✅ SubsystemId is 999 in config?
- ✅ I/O data imported?
- ✅ Check backend logs for simulator messages

---

## Code Changes Made

### **Files Modified:**

1. **`frontend/components/plc-toolbar.tsx`**
   - Added `Zap` and `ZapOff` icons
   - Added props for simulator control
   - Added simulator button (admin only)

2. **`frontend/app/commissioning/[id]/page.tsx`**
   - Added `isSimulatorEnabled` state
   - Added `handleToggleSimulator` function
   - Added `useEffect` to check simulator status on mount
   - Passed props to `PlcToolbar`

---

## Summary

✅ **Simulator button added to UI**
✅ **Admin only** - regular users won't see it
✅ **One-click toggle** - easy to use
✅ **Visual feedback** - purple when ON
✅ **Status check** - shows correct state on load

**No more PowerShell commands needed!** Just click the button! 🎉

