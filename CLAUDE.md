# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Industrial I/O Checkout Tool for commissioning PLC systems. Technicians use this on tablets to test and validate I/O points during factory commissioning.

**Architecture:** Fully self-contained Node.js application. No external backend — all logic runs inside Next.js API routes with a local SQLite database.

**How it works:**
1. User opens app → logs in with 6-digit PIN
2. User clicks "Pull IOs" → fetches I/O definitions from remote PostgreSQL, stores in local SQLite
3. PLC communication via libplctag (ffi-rs), continuously reads tag states (75ms intervals)
4. Tag states broadcast via WebSocket (port 3001) to all connected browsers
5. State transitions (FALSE→TRUE) prompt technician to mark Pass/Fail
6. Results stored locally; cloud sync is manual (triggered by user when done testing)

## Tech Stack

- **Runtime**: Node.js 20+, Next.js 14 (App Router), React 18, TypeScript
- **UI**: Tailwind CSS, shadcn/ui (Radix UI), TanStack Virtual
- **Database**: Prisma ORM + SQLite (local)
- **PLC**: ffi-rs → libplctag native library (Ethernet/IP)
- **Real-time**: WebSocket (ws library, port 3001)
- **Auth**: JWT + bcrypt, PIN-based login (default admin PIN: `111111`)
- **Deployment**: Portable folder on Windows, Docker on Linux

## Common Commands

### Development
```bash
cd frontend

npm install          # First-time setup (also runs prisma generate)
npm run dev          # Start dev server (Next.js :3020 + WebSocket :3001)
npm run dev:next     # Next.js only (port 3020)
npm run dev:ws       # WebSocket server only (port 3001)
npm run build        # Production build (standalone output)
npm run lint         # ESLint
npm run test:plc     # Test PLC connection
```

### Production (Windows Factory)
```
deploy\BUILD-PORTABLE.bat    # Build portable distribution
deploy\SETUP-FIREWALL.bat    # Open ports 3000/3001 (run once as admin)

# In the portable/ folder:
START.bat                    # Start app (port 3000 + WebSocket 3001)
STOP.bat                     # Stop app
STATUS.bat                   # Check if running, show IP addresses
```

### Docker (Linux)
```bash
cd docker && docker compose up -d --build    # Start on port 3000
cd docker && docker compose down             # Stop
cd docker && docker compose logs -f          # View logs
```

## Project Structure

```
local-tool/
├── frontend/                        # The entire application
│   ├── app/                         # Next.js App Router
│   │   ├── page.tsx                 # Login page
│   │   ├── commissioning/[id]/      # Main testing page
│   │   └── api/                     # API routes (ALL backend logic)
│   │       ├── ios/                 # I/O CRUD, test, reset, fire-output, state
│   │       ├── plc/                 # PLC connect, disconnect, status, toggle-testing
│   │       ├── cloud/               # Pull IOs, sync, status
│   │       ├── auth/                # Login (PIN-only), verify
│   │       ├── configuration/       # Config CRUD, runtime, connect
│   │       ├── history/             # Test history (all + per-IO)
│   │       ├── simulator/           # Enable, disable, status
│   │       └── health/              # Health check
│   ├── components/                  # React components (shadcn/ui)
│   ├── lib/
│   │   ├── plc/                     # PLC native bindings
│   │   │   ├── libplctag.ts         # ffi-rs wrapper for libplctag C library
│   │   │   ├── plc-client.ts        # High-level PLC client (connect, read, write)
│   │   │   ├── tag-reader.ts        # Continuous 75ms tag reading loop
│   │   │   ├── websocket-client.ts  # Browser-side WebSocket hook
│   │   │   └── types.ts             # PLC types + WebSocket message types
│   │   ├── plc-client-manager.ts    # Singleton PLC client + broadcast helper
│   │   ├── db/                      # Prisma singleton + repositories
│   │   ├── auth/                    # JWT, bcrypt, middleware helpers
│   │   ├── cloud/                   # Cloud sync service
│   │   ├── config/                  # Config service (file-based, hot-reload)
│   │   ├── services/                # IO test service, PLC simulator
│   │   ├── api-config.ts            # API endpoints, authFetch, WebSocket URL
│   │   └── signalr-client.ts        # Compat wrapper (re-exports WebSocket client)
│   ├── prisma/schema.prisma         # Database schema (SQLite)
│   ├── scripts/plc-websocket-server.js  # WebSocket broadcast server
│   ├── server.js                    # Production server
│   └── server.dev.js                # Dev server launcher
├── deploy/                          # Windows deployment scripts
└── docker/                          # Docker deployment
```

## Key Patterns

### Single Process Architecture
```
Browser → http://SERVER:3000 → Next.js API Routes → SQLite / PLC
Browser → ws://SERVER:3001   → WebSocket server  ← PLC tag reader broadcasts
```

### WebSocket Broadcast Flow
API routes push messages to the WebSocket server via internal HTTP:
```
API Route → POST http://localhost:3101/broadcast → WebSocket server → all browsers
```
The broadcast URL is centralized in `getWsBroadcastUrl()` from `lib/plc-client-manager.ts`.

### Auth
- PIN-only login: client sends `{ pin }`, server iterates active users to find match
- JWT tokens (8h expiry) stored in localStorage
- `requireAuth` / `withAuth` / `withAdmin` helpers in `lib/auth/middleware.ts`
- Middleware redirects unauthenticated page requests to `/`

### Pull IOs Flow
```
POST /api/cloud/pull → fetch from remote PostgreSQL → store in local SQLite → UI refreshes
```

### Test Result Recording
`POST /api/ios/[id]/test` — transactional update of IO record + TestHistory creation.
Cloud sync is NOT automatic — triggered manually by user via the Sync dialog.

## Database (SQLite via Prisma)

| Table | Purpose |
|-------|---------|
| Ios | I/O definitions with Result, Timestamp, Comments, TagType, Version |
| TestHistories | Audit trail (result, testedBy, failureMode, state, timestamp) |
| PendingSyncs | Offline queue for manual cloud sync |
| Users | PIN-based auth (bcrypt hashed) |
| Projects / Subsystems | Organization hierarchy |
| TagTypeDiagnostics | Diagnostic help data per tag type |

Schema: `frontend/prisma/schema.prisma`. Run `npx prisma generate` after changes.

## Ports

| Port | Context | Purpose |
|------|---------|---------|
| 3020 | Development | Next.js dev server |
| 3000 | Production | Next.js production server |
| 3001 | Both | WebSocket server (PLC state broadcasts) |
| 3101 | Both | Internal HTTP broadcast API (localhost only) |

## Important Caveats

- **Native library required**: `plctag.dll` (Windows) or `libplctag.so` (Linux) must be accessible
- **No auto-connect**: App does NOT connect to PLC on startup — user must configure and connect
- **Manual cloud sync**: Test results are stored locally; sync to cloud is triggered by the user
- **Single Prisma instance**: `lib/prisma.ts` re-exports from `lib/db` — always use one or the other
- **`signalr-client.ts`** is a backward-compat wrapper; actual transport is plain WebSocket
