# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Industrial I/O Checkout Tool for commissioning PLC systems. Technicians use this on tablets to test and validate I/O points during factory commissioning.

**Architecture:** Fully self-contained Node.js application. No external backend — all logic runs inside Next.js API routes with a local SQLite database.

**How it works:**
1. User opens app → logs in with 6-digit PIN
2. User clicks "Pull IOs" → fetches I/O definitions from remote PostgreSQL, stores in local SQLite
3. PLC communication via libplctag (ffi-rs), continuously reads tag states (75ms intervals)
4. Tag states broadcast via WebSocket (port 3002) to all connected browsers
5. State transitions (FALSE→TRUE) prompt technician to mark Pass/Fail
6. Results stored locally; auto-sync pushes to cloud every 30s, pulls every 60s

## Tech Stack

- **Runtime**: Node.js 20+, Next.js 14 (App Router), React 18, TypeScript
- **UI**: Tailwind CSS, shadcn/ui (Radix UI), TanStack Virtual
- **Database**: Prisma ORM + SQLite (local, WAL mode)
- **PLC**: ffi-rs → libplctag native library (Ethernet/IP)
- **Real-time**: WebSocket (ws library, port 3002)
- **Auth**: JWT + bcrypt, PIN-based login (default admin PIN: `111111`)
- **Deployment**: Portable folder on Windows, Docker on Linux

## Common Commands

### First-Time Setup
```bash
cd frontend
cp env.example .env.local        # Create local environment config
npm install                       # Install deps + generate Prisma client (postinstall)
npx prisma db push                # Create SQLite database from schema
npm run seed:diagnostics          # Optional: seed diagnostic help data
npm run seed:network              # Optional: seed network topology test data
```

### Development
```bash
cd frontend

npm run dev          # Start dev server (Next.js :3020 + WebSocket :3002)
npm run dev:next     # Next.js only (port 3020, no real-time PLC updates)
npm run dev:ws       # WebSocket server only (port 3002)
npm run build        # Production build (standalone output)
npm run lint         # ESLint
npm run test:plc     # Full PLC connection test (reads tags, monitors 10s)
npm run test:plc:simple  # Quick PLC connection test
```

### Production (Windows Factory)
```
deploy\BUILD-PORTABLE.bat    # Build portable distribution (bundles Node.js, plctag.dll)
deploy\SETUP-FIREWALL.bat    # Open ports 3000/3002 (run once as admin)

# In the portable/ folder:
START.bat                    # Start app (port 3000 + WebSocket 3002)
STOP.bat                     # Stop app
STATUS.bat                   # Check if running, show IP addresses
```

### Docker (Linux)
```bash
cd docker && docker compose up -d --build    # Start on port 3000
cd docker && docker compose down             # Stop
```

### Database
```bash
cd frontend
npx prisma generate          # Regenerate client after schema changes
npx prisma db push            # Apply schema changes to database
npx prisma studio             # Visual database browser
npx tsx prisma/assign-tag-types.ts  # Auto-assign tag types from IO descriptions
```

## Project Structure

```
├── frontend/                        # The entire application
│   ├── app/                         # Next.js App Router
│   │   ├── page.tsx                 # Login page (PIN entry)
│   │   ├── commissioning/[id]/      # Main testing page
│   │   └── api/                     # API routes (ALL backend logic)
│   │       ├── ios/                 # I/O CRUD, test, reset, fire-output, state, stats
│   │       ├── plc/                 # PLC connect, disconnect, status, toggle-testing
│   │       ├── cloud/               # Pull IOs, sync, auto-sync, status
│   │       ├── auth/                # Login (PIN-only), verify
│   │       ├── configuration/       # Config CRUD, runtime, connect, logs
│   │       ├── history/             # Test history (all + per-IO + CSV export)
│   │       ├── users/               # User CRUD, reset PIN, toggle active
│   │       ├── diagnostics/         # Failure modes, troubleshooting steps
│   │       ├── network/             # DLR ring topology, chain status
│   │       ├── change-requests/     # IO change requests (CRUD)
│   │       ├── backups/             # Database backup create/download/delete/sync
│   │       ├── simulator/           # Enable, disable, status
│   │       └── health/              # Health check
│   ├── components/                  # React components (shadcn/ui)
│   ├── lib/
│   │   ├── plc/                     # PLC native bindings
│   │   │   ├── libplctag.ts         # ffi-rs wrapper for libplctag C library
│   │   │   ├── plc-client.ts        # High-level PLC client (connect, read, write)
│   │   │   ├── tag-reader.ts        # Continuous 75ms tag reading loop + DINT grouping
│   │   │   ├── websocket-client.ts  # Browser-side WebSocket hook
│   │   │   └── types.ts             # PLC types + WebSocket message types
│   │   ├── plc-client-manager.ts    # Singleton PLC client + WS broadcast helper
│   │   ├── db/                      # Prisma singleton + repositories
│   │   ├── auth/                    # JWT, bcrypt, middleware helpers
│   │   ├── cloud/                   # Cloud sync service + auto-sync loops
│   │   ├── config/                  # Config service (file-based, hot-reload via fs.watch)
│   │   ├── services/                # IO test service, PLC simulator
│   │   └── api-config.ts            # API endpoints, authFetch, WebSocket URL
│   ├── prisma/schema.prisma         # Database schema (SQLite)
│   ├── scripts/plc-websocket-server.js  # WebSocket broadcast server
│   ├── server.js                    # Production server (Next.js + WS + broadcast)
│   └── server.dev.js                # Dev server (spawns Next.js + WS as children)
├── deploy/                          # Windows deployment scripts
└── docker/                          # Docker deployment
```

## Key Patterns

### Single Process Architecture
```
Browser → http://SERVER:3000 → Next.js API Routes → SQLite / PLC
Browser → ws://SERVER:3002   → WebSocket server  ← PLC tag reader broadcasts
```

### WebSocket Broadcast Flow
API routes push messages to the WebSocket server via internal HTTP POST:
```
API Route → POST http://localhost:3102/broadcast → WebSocket server → all browsers
```
The broadcast URL is centralized in `getWsBroadcastUrl()` from `lib/plc-client-manager.ts`. Internal broadcast port = WS_PORT + 100 (3102 in dev, 3102 in prod with default config).

### Singleton Services (globalThis pattern)
PLC client, Prisma, and ConfigurationService all use `globalThis` to persist across hot reloads in development. Always use the accessor functions (`getPlcClient()`, `prisma`, `configService`) — never instantiate directly.

### Auth
- PIN-only login: client sends `{ pin }`, server iterates active users to find match
- JWT tokens (8h expiry) stored in localStorage
- `requireAuth` / `withAuth` / `withAdmin` helpers in `lib/auth/middleware.ts`
- Middleware redirects unauthenticated page requests to `/`
- Roles: `admin` (full access), `user` (test only, no config/PLC/cloud)

### Cloud Sync (Bidirectional)
- **Instant push**: every pass/fail, comment, and reset is pushed to cloud immediately (~1-2 seconds)
- **Background fallback**: auto-sync retries pending syncs every 30s if instant push fails; pull every 60s
- **Pull merge rule**: local results are never overwritten; only IOs you haven't tested get cloud results
- **Manual "Pull IOs"**: full replace of IO definitions from cloud (auto-syncs pending results first, creates backup)
- **Offline resilience**: PendingSyncs queue persists in SQLite, retries on reconnect
- **Live cloud dashboard**: cloud app receives updates via SSE — project dashboard updates in real-time without refresh
- **Version sync**: local sends pre-increment version to match cloud's current version for atomic updates
- See `SYNC-ARCHITECTURE.md` for full details

### PLC Auto-Reconnect
- On connection loss (PLC power cycle, network drop), auto-reconnects every 5 seconds
- No admin intervention needed — testing mode resumes automatically
- Toolbar shows amber "Reconnecting" indicator during retry
- Intentional disconnect (clicking disconnect) stops auto-reconnect

### Test Result Recording
`POST /api/ios/[id]/test` — transactional update of IO record + TestHistory creation. Every test attempt is permanently recorded in the audit trail (TestHistory), even if later retested or overwritten by sync.

### Configuration
File-based `config.json` in `frontend/` directory. ConfigurationService watches the file with `fs.watch` and notifies listeners on changes. Config includes PLC IP/path, cloud URL/credentials, subsystem ID, column visibility.

## Database (SQLite via Prisma)

| Table | Purpose |
|-------|---------|
| Io | I/O definitions with Result, Timestamp, Comments, TagType, Version |
| TestHistory | Audit trail (result, testedBy, failureMode, state, timestamp) |
| PendingSync | Offline queue for cloud sync |
| User | PIN-based auth (bcrypt hashed), roles (admin/user) |
| Project / Subsystem | Organization hierarchy |
| TagTypeDiagnostic | Diagnostic troubleshooting steps per tag type |
| ChangeRequest | IO change requests (requestType, status, reviewedBy) |
| NetworkRing / NetworkNode / NetworkPort | DLR ring topology and star connections |

Schema: `frontend/prisma/schema.prisma`. Run `npx prisma generate` after changes.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `file:./database.db` | SQLite database path |
| `JWT_SECRET_KEY` | — | Secret for signing auth tokens |
| `PLC_WS_PORT` | `3002` | WebSocket server port |
| `NODE_ENV` | `development` | Node environment |

## Ports

| Port | Context | Purpose |
|------|---------|---------|
| 3020 | Development | Next.js dev server |
| 3000 | Production | Next.js production server |
| 3002 | Both | WebSocket server (PLC state broadcasts) |
| 3102 | Both | Internal HTTP broadcast API (localhost only, WS_PORT+100) |

## Important Caveats

- **Native library required**: `plctag.dll` (Windows) or `libplctag.so` (Linux) must be accessible
- **No auto-connect**: App does NOT connect to PLC on startup — user must configure and connect
- **Single Prisma instance**: `lib/prisma.ts` re-exports from `lib/db` — always use one or the other
- **`signalr-client.ts`** is a backward-compat wrapper; actual transport is plain WebSocket
- **No automated test suite**: Testing is manual via PLC test scripts (`test:plc`, `test:plc:simple`)
- **Standalone build**: `next.config.mjs` uses `output: 'standalone'` — production doesn't need `node_modules` except native packages (prisma, ws, ffi-rs)
