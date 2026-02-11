# IO Checkout Tool

Factory commissioning tool for testing PLC Input/Output points. Technicians connect to a PLC, see live I/O states in real time, and mark each point as Pass or Fail.

## Quick Start

### 1. First-Time Setup

```bash
# Backend (port 5000)
cd backend
cp config.json.template config.json   # edit with your PLC settings
dotnet run

# Frontend (port 3002) - separate terminal
cd frontend
npm install
PORT=3002 npm run dev
```

On Windows, `start-dev.bat` does both at once.

### 2. Open the App

Go to `http://localhost:3002`. You'll see the PIN login screen.

**Default admin login:** PIN `852963`

After entering your PIN you get a JWT token (valid 8 hours). All API calls use this token automatically. When it expires, you're redirected back to login.

### 3. Configure PLC Connection

You have two options:

**Option A - Edit `backend/config.json` directly:**
```json
{
  "ip": "192.168.1.100",
  "path": "1,0",
  "subsystemId": "16",
  "remoteUrl": "",
  "ApiPassword": "",
  "orderMode": "0"
}
```
Save the file. The app detects the change and **automatically reconnects** - no restart needed.

**Option B - Use the UI:**
Click the gear icon in the toolbar, enter PLC IP / path / subsystem ID, and save. The app reinitializes in the background.

### 4. Testing Workflow

1. Click **Start Testing** in the toolbar
2. The app reads I/O states from the PLC every 75ms
3. When an **input** goes FALSE -> TRUE, a dialog pops up asking Pass or Fail
4. For **outputs**, click the fire button to toggle the output, observe the physical response, then mark Pass or Fail
5. If you mark Fail, you must select a failure reason and can add a comment
6. All results are saved locally and synced to cloud (if configured)

### 5. PLC Simulator (No Hardware)

For testing without a real PLC:

```bash
# Enable (random state changes every 2 seconds)
curl -X POST http://localhost:5000/api/simulator/enable

# Disable
curl -X POST http://localhost:5000/api/simulator/disable
```

Or use the simulator toggle button in the toolbar.

---

## Authentication

PIN-based login with JWT tokens. No accounts to create for technicians - the admin creates users in the Users panel.

- Login returns a JWT token stored in the browser
- Every API call includes the token automatically
- Token expires after 8 hours (matches a factory shift)
- Login is rate-limited: 5 attempts per minute per IP
- Direct API calls without a token return 401

The frontend handles all of this transparently. If your session expires, you'll see the login screen again.

---

## Changing PLC Configuration Without Restarting

**You never need to restart the app to change PLC settings.** Both methods work live:

**Via config.json:** Edit the file and save. A file watcher detects the change, disconnects from the old PLC, connects to the new one, fetches fresh I/O definitions from cloud, and broadcasts the change to all open browsers. You'll see a brief "Reloading..." banner in the UI.

**Via the UI config dialog:** Same process but triggered by the save button instead of a file watcher.

**What happens during reconnection:**
1. All SignalR clients are notified (UI shows loading state)
2. Old PLC tags are disconnected and disposed
3. New PLC connection is established with the updated IP/path
4. If cloud is configured, fresh I/O definitions are fetched
5. If cloud is unavailable, the app falls back to local SQLite data
6. Tag reading resumes on the new connection
7. All clients are notified that reload is complete

---

## When Things Go Wrong

### Connection Failures

| Problem | What Happens | What To Do |
|---------|-------------|------------|
| PLC unreachable | Toolbar shows "Disconnected". I/O states freeze. | Check PLC IP/path in config. Check network cable. The app retries automatically. |
| Cloud unavailable | App works fully offline. Test results queue locally. | Results sync automatically when cloud returns. Check `remoteUrl` in config. |
| Backend down | Frontend shows "Cannot connect to backend" | Check if backend process is running on port 5000. |
| SignalR drops | Brief "Reconnecting..." in UI, auto-reconnects with backoff | Usually recovers in seconds. If persistent, check network. |
| Token expired | Redirected to login screen | Enter your PIN again. Normal after 8 hours. |

### Error Log Panel

The UI has an error log panel (collapsible, below the toolbar) that shows recent errors from:
- PLC connection issues
- Cloud sync failures
- SignalR disconnections
- Tag read errors

Errors appear as toast notifications and are collected in the panel for review.

### Backend Logs

Log files are in `backend/logs/` (daily rotation, 30 days retained):

```
backend/logs/backend-2026-02-10.log
```

Format: `timestamp [level] source: message`

Logs also print to the terminal where the backend is running.

**What to look for:**
- `[ERR]` lines for actual errors
- `PlcCommunicationService` for PLC connection issues
- `ResilientCloudSyncService` for cloud sync problems
- `ConfigFileWatcherService` for config reload events
- `TagReaderService` for tag read failures

### Frontend Logs

In development (`npm run dev`), debug logs appear in the browser console. In production builds, only errors are logged.

---

## Docker Deployment

```bash
docker compose up -d
```

This starts both backend (port 5000) and frontend (port 3002). Data persists in a Docker volume.

Set `DATA_DIR=/data` in the backend container to control where the database and logs are stored.

---

## Offline Operation

The app is designed for factory floors where internet may be unreliable:

- I/O definitions are cached in local SQLite after first cloud sync
- Test results are saved locally immediately
- If cloud is unavailable, results queue in a `PendingSyncs` table
- When cloud returns, queued results sync automatically
- You can also manually trigger cloud sync from the toolbar

---

## Project Structure

```
commissioning-local/
  backend/           C# .NET 9 backend (port 5000)
    config.json      PLC connection settings (edit this)
    database.db      Local SQLite database
    logs/            Backend log files
  frontend/          Next.js frontend (port 3002)
  Shared.Library/    Shared C# models and DTOs
```

Key ports: **5000** (backend API + SignalR), **3002** (frontend UI).

All frontend API calls proxy through Next.js to the backend, so only port 3002 needs to be accessible to browsers.
