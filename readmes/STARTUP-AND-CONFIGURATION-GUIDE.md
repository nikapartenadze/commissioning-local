# Startup and Configuration Guide

This guide explains how the IO Checkout Tool starts up, how configuration changes are handled, and when restarts are required.

## Table of Contents

1. [Startup Sequence](#startup-sequence)
2. [Configuration Changes](#configuration-changes)
3. [When Restarts Are Required](#when-restarts-are-required)
4. [Troubleshooting](#troubleshooting)

---

## Startup Sequence

The application starts in a specific order to ensure all dependencies are properly initialized:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        APPLICATION STARTUP                          │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 1. DATABASE INITIALIZATION                                          │
│    - Creates SQLite database if not exists                          │
│    - Applies any pending migrations                                 │
│    - Enables WAL mode for concurrent access                         │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 2. CLOUD SYNC                                                       │
│    - Connects to remote PostgreSQL via SignalR                      │
│    - Fetches I/O definitions for configured subsystem               │
│    - Caches data in local SQLite                                    │
│    - If cloud unavailable, uses cached local data                   │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 3. PLC INITIALIZATION                                               │
│    - Loads I/O definitions from local SQLite                        │
│    - Creates PLC tags using libplctag.dll                           │
│    - Starts continuous tag reading loop (75ms intervals)            │
│    - Requires I/O list from step 2!                                 │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 4. OFFLINE SYNC SERVICE                                             │
│    - Processes any pending sync items from offline queue            │
│    - Pushes test results to cloud when connection restored          │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 5. CONFIG FILE WATCHER                                              │
│    - Monitors config.json for external changes                      │
│    - Auto-triggers reinitialization when file is edited             │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 6. FRONTEND READY                                                   │
│    - SignalR connection established                                 │
│    - I/O data displayed in real-time                                │
│    - Testing can begin                                              │
└─────────────────────────────────────────────────────────────────────┘
```

### Why Order Matters

- **Database must initialize first** - All other services need the database
- **Cloud sync before PLC** - PLC service needs I/O definitions from cloud
- **Offline sync after PLC** - Processes pending items once connections are ready

---

## Configuration Changes

### How Configuration Is Stored

Configuration is stored in `config.json` in the backend directory:

```json
{
  "Ip": "192.168.1.100",
  "Path": "1,0",
  "SubsystemId": "16",
  "RemoteUrl": "https://cloud-server.com",
  "ApiPassword": "secret",
  "OrderMode": "0",
  "DisableWatchdog": "false"
}
```

### Three Ways to Change Configuration

#### 1. Through the UI (Recommended)

- Open the configuration dialog in the application
- Make changes and click Save
- Application automatically reinitializes with new settings
- **No restart required**

#### 2. External Edit with Auto-Reload

- Edit `config.json` directly with a text editor
- Save the file
- Application automatically detects the change
- Reinitialization happens automatically
- **No restart required** (since v2.0)

#### 3. External Edit (Manual)

If auto-reload doesn't work:
1. Edit `config.json`
2. Restart the application manually

### Auto-Reload Behavior

When you edit `config.json` externally:

1. **File watcher detects change** (within 1 second)
2. **Debounce period** - Waits for editor to finish writing
3. **Configuration reloads** - Values read from file
4. **Services reinitialize** - In the correct order:
   - Watchdog service restarts
   - PLC connections recreated
   - Cloud sync reconnects
   - I/O definitions refreshed
5. **Frontend notified** - Banner shows reload status

---

## When Restarts Are Required

### Restarts NOT Required

| Change | Method | Restart Needed? |
|--------|--------|-----------------|
| PLC IP/Path | UI | No |
| PLC IP/Path | Edit config.json | No (auto-reload) |
| Subsystem ID | UI | No |
| Cloud URL | UI | No |
| Column visibility | UI | No |
| API Password | UI | No |

### Restarts Required

| Change | Reason |
|--------|--------|
| Backend port (5000) | Port is bound at process start |
| Frontend port (3002) | Port is bound at process start |
| Environment variables | Read once at process start |
| Node.js location | Resolved at batch script execution |
| .NET runtime | Loaded at process start |

### Environment Variables

Environment variables are read **once at process startup** and cached:

```
┌──────────────────────────────────────────────────────────────┐
│                    PROCESS STARTUP                           │
│                                                              │
│  set BACKEND_PORT=5000    ──►  Cached in process memory     │
│  set FRONTEND_PORT=3002   ──►  Cached in process memory     │
│                                                              │
│  After this point, changing these variables has NO effect   │
│  until you restart the process!                             │
└──────────────────────────────────────────────────────────────┘
```

**If you need to change ports:**
1. Edit the BAT script (`START.bat` or `start-dev.bat`)
2. Stop the running application
3. Run the script again in a new terminal

---

## Troubleshooting

### Application Won't Start

**Check:**
1. Is port 5000 already in use? `netstat -ano | findstr :5000`
2. Is `config.json` valid JSON? (no trailing commas, proper quotes)
3. Does `plctag.dll` exist in the backend folder?

### PLC Not Connecting

**Check:**
1. Is the PLC IP correct in config.json?
2. Can you ping the PLC? `ping 192.168.1.100`
3. Is the Ethernet/IP path correct? (typically "1,0")

### Cloud Sync Failing

**Check:**
1. Is `RemoteUrl` correct in config.json?
2. Is `ApiPassword` correct?
3. Can you access the cloud server from this network?

### Config Changes Not Taking Effect

**If you edited config.json manually:**
1. Check the console/logs for "ConfigurationReloading" message
2. If no message, the file watcher may not be working
3. Try saving the file again, or restart the application

**If you used the UI:**
1. Check the console for any error messages
2. Verify the values saved correctly by opening config.json

### Frontend Not Showing Updates

**Check:**
1. Is the backend running? Check http://localhost:5000/api/status
2. Is SignalR connected? (check browser console)
3. Refresh the page to re-establish connection

---

## Quick Reference

### Batch Scripts

| Script | Purpose |
|--------|---------|
| `START.bat` | Starts backend and frontend (portable) |
| `STOP.bat` | Stops all running processes |
| `STATUS.bat` | Shows which processes are running |
| `start-dev.bat` | Starts in development mode |

### Default Ports

| Service | Port |
|---------|------|
| Backend | 5000 |
| Frontend | 3002 |
| SignalR Hub | 5000 (same as backend) |

### Key Files

| File | Purpose |
|------|---------|
| `config.json` | PLC/cloud configuration |
| `database.db` | Local SQLite database |
| `plctag.dll` | Native PLC communication library |

---

## For Factory IT Staff

### First-Time Setup

1. Copy the `portable/` folder to the target machine
2. Copy `config.json.template` to `config.json`
3. Edit `config.json` with the correct PLC IP and subsystem ID
4. Run `START.bat`
5. Open browser to http://localhost:3002

### Daily Operation

1. Double-click `START.bat` to start the application
2. Use `STOP.bat` to shut down when done
3. Configuration changes through the UI are preferred

### Switching to a Different PLC

1. Open the configuration dialog in the UI
2. Enter the new PLC IP and path
3. Click Save - application will reconnect automatically

### Switching to a Different Subsystem

1. Open the configuration dialog
2. Change the Subsystem ID
3. Click Save - new I/O definitions will be fetched from cloud
