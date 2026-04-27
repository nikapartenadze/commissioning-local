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
```

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
