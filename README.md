# Commissioning Tool

Field commissioning tool for industrial PLC systems. Used by technicians on tablets and laptops to test, validate, and commission conveyor and VFD systems on-site.

## What It Does

- Connects to Allen-Bradley PLCs over Ethernet/IP
- Reads and writes PLC tags in real-time via WebSocket
- VFD commissioning wizard (identity, HP, bump test, controls, speed calibration)
- L2 Functional Validation spreadsheet with pass/fail tracking
- I/O point testing with live state monitoring
- Offline-first with local SQLite database
- Syncs results to cloud when connected
- Safety zone and E-Stop verification
- Network topology visualization

## Tech Stack

- **Client:** Vite + React 18 + React Router
- **Server:** Express 5 + TypeScript
- **Database:** SQLite (better-sqlite3)
- **PLC:** libplctag via ffi-rs
- **Realtime:** WebSocket on port 3000

## Quick Start

```bash
cd frontend
npm install
npm run dev
```

- Vite client: http://localhost:5173
- Express API + WebSocket: http://localhost:3000

## Distribution

Ships as a portable ZIP (~42 MB) or Windows NSIS installer (~55 MB). No installation required for portable mode — extract and run `START.bat`.

```bash
# Build portable
cd deploy
powershell -ExecutionPolicy Bypass -File build-portable-auto.ps1

# Or use the batch file
BUILD-PORTABLE.bat

# Or the full installer (portable + NSIS)
BUILD-INSTALLER.bat
```

## Auto-Update (v2.38.0+)

Tablets running v2.38.0 or later can be updated remotely with one click from the commissioning-cloud admin UI — no walking around the site with a USB stick.

### How it works

```
Admin clicks "Push update" on a tablet card
  → POST /api/admin/instances/:id/commands { type: "update" }
  → row queued in laptop_commands (status: pending)
  → tablet's next heartbeat (≤30 s) picks the command up
  → tablet spawns tools/install-update.ps1 detached
  → ps1: backs up DB+config, stops service, runs installer /S, restarts, /api/health check
  → tablet's next heartbeat reports the new version → card flips
```

Total round-trip: ~60–120 s depending on installer size and link speed.

### What the tablet looks for

`lib/update/update-utils.ts` resolves the release manifest URL in this order:

1. `UPDATE_MANIFEST_URL` env var
2. `updateManifestUrl` field in `config.json`
3. **Default**: `https://commissioning.autstand.com/api/releases/latest`

So every v2.38.0+ tablet gets self-update for free, no per-tablet config edit.

### Safeties

- Refuses downgrades (`compareVersions(requested, current) <= 0` → no-op)
- Refuses stacked installs (one update in flight at a time)
- Refuses on non-Windows
- Validates `http(s)://` on the installer URL before spawning
- Backs up `database.db` and `config.json` to `backups/` before every install — restore by copying back if anything goes wrong

### Bootstrap state

**v2.38.0 was the last manual install.** Tablets on builds older than v2.38.0 don't recognize the `update` command — the cloud will still queue it, but the laptop reports `failed: unknown command type` in the fleet UI, telling the admin which tablets still need a manual install.

### Shipping a new release (e.g. v2.39.0)

1. Bump `frontend/package.json` and `deploy/BUILD-INSTALLER.bat` to `2.39.0`
2. `cd commissioning-local && rmdir /s portable && deploy\BUILD-INSTALLER.bat` (produces `CommissioningTool-Setup-v2.39.0.exe`)
3. Commit, tag `v2.39.0`, push, create the GitHub release with the `.exe` attached
4. Copy the `.exe` to `commissioning-cloud/public/downloads/`
5. `cd commissioning-cloud && .\deploy.ps1` (builds + pushes Docker image to `registry.lci.ge/commissioning/app:latest`)
6. `ssh dockerhost "cd /home/adminuser/apps/commissioning && docker pull registry.lci.ge/commissioning/app:latest && docker compose down && docker compose up -d"`
7. Verify `curl https://commissioning.autstand.com/api/releases/latest` returns the new version
8. Open the cloud admin UI → fleet tab → click **Push update** on each tablet. Cards flip to the new version as each tablet finishes installing.

The manifest endpoint auto-picks the highest semver in `public/downloads/` — leaving older `.exe`s there is harmless but bloats the image. Prune to the last two or three on each release.

## Project Structure

```
frontend/
  app/api/          # Express route handlers
  components/       # React UI components
  lib/              # Database, PLC, sync, config services
  routes/           # Express router mount table
  server-express.ts # Production server entry point
  src/              # Vite client entry point
deploy/             # Build scripts, installer, batch templates
```

## Ports

| Port | Purpose |
|------|---------|
| 3000 | HTTP server + WebSocket |
| 3102 | Internal broadcast API (localhost only) |
| 5173 | Vite dev server (dev only) |
