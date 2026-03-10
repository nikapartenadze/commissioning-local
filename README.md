# IO Checkout Tool

Industrial I/O commissioning application for testing and validating PLC Input/Output points. Technicians use this on tablets and laptops during factory commissioning to systematically test every sensor, switch, valve, and motor.

## How It Works

1. I/O definitions are pulled from remote PostgreSQL and cached locally in SQLite
2. App connects to PLC via libplctag (ffi-rs), reads tag states at 75ms intervals
3. State changes are broadcast via WebSocket to all connected browsers
4. When an input transitions (FALSE → TRUE), a dialog prompts the technician to mark Pass/Fail
5. Results are stored locally; sync to cloud is done manually when testing is complete

## Prerequisites

- **Node.js 20+** — [download](https://nodejs.org)
- **libplctag native library** — `plctag.dll` on Windows, `libplctag.so` on Linux ([releases](https://github.com/libplctag/libplctag/releases))

## Development

All source code lives in the `frontend/` directory. There is no separate backend — everything runs as a single Next.js application.

### First-Time Setup

```bash
cd frontend
cp env.example .env.local   # Create local environment config
npm install                  # Install deps + generate Prisma client
npx prisma db push           # Create SQLite database from schema
```

### Starting the Dev Server

```bash
cd frontend
npm run dev
```

This runs `server.dev.js` which starts **two processes** together:
- **Next.js dev server** on port `3020` (hot reload, API routes, UI)
- **PLC WebSocket server** on port `3002` (broadcasts real-time tag state changes to browsers)

Open `http://localhost:3020` in your browser.

#### Alternative dev commands

| Command | What it does |
|---------|-------------|
| `npm run dev` | Starts both Next.js and WebSocket server (recommended) |
| `npm run dev:next` | Starts only Next.js on port 3020 (no real-time PLC updates) |
| `npm run dev:ws` | Starts only the WebSocket server on port 3002 |
| `npm run dev:full` | Starts both via `concurrently` (alternative to `npm run dev`) |

### Environment Variables

Copy `env.example` to `.env.local` and edit as needed:

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `file:./database.db` | SQLite database path |
| `JWT_SECRET_KEY` | — | Secret for signing auth tokens (change in production) |
| `PLC_WS_PORT` | `3002` | WebSocket server port |
| `WS_BROADCAST_URL` | `http://localhost:3102/broadcast` | Internal HTTP broadcast endpoint (auto-derived) |
| `NODE_ENV` | `development` | Node environment |

### Building for Production

```bash
cd frontend
npm run build
```

This creates a **standalone** Next.js build in `frontend/.next/standalone/` — a self-contained Node.js app that doesn't need `node_modules` at runtime (except native modules like `prisma`, `ws`, `ffi-rs`).

### Linting

```bash
cd frontend
npm run lint
```

### Testing PLC Connection

```bash
cd frontend

# Full PLC connection test (connects, reads tags, monitors changes)
npm run test:plc

# Quick connection test
npm run test:plc:simple
```

Requires `PLC_IP` and `PLC_PATH` environment variables or a running PLC on the network.

## Production Deployment (Factory Windows PCs)

The app is deployed as a **portable folder** — copy to the server, double-click to start. One server PC runs the app, technicians connect from tablets/laptops via browser.

### Building the Portable Distribution

On your dev machine:

```
deploy\BUILD-PORTABLE.bat
```

This creates a `portable/` folder containing:
- Pre-built Next.js standalone app
- WebSocket server script
- Prisma client and schema
- Startup/shutdown scripts
- Default `.env` configuration

### Deploying to the Factory Server

1. Copy the `portable/` folder to the server PC (e.g., `C:\IOCheckout`)
2. Install [Node.js 20+](https://nodejs.org) on the server if not already installed
3. Place `plctag.dll` in `portable\app\` (download from [libplctag releases](https://github.com/libplctag/libplctag/releases))
4. Run `SETUP-FIREWALL.bat` **as Administrator** (one-time — opens ports 3000 and 3002)
5. Edit `portable\app\.env` if you need to change ports or the JWT secret

### Running in Production

| Script | What it does |
|--------|-------------|
| `START.bat` | Starts the app (Next.js on port 3000, WebSocket on port 3002) |
| `STOP.bat` | Stops the app |
| `STATUS.bat` | Shows if the app is running and prints the server's IP addresses |

Technicians open `http://SERVER_IP:3000` on their tablets. Default admin PIN: `852963`.

### Production Ports

| Port | Purpose | Who connects |
|------|---------|-------------|
| 3000 | Web UI + API | Technicians (tablets/laptops) |
| 3002 | WebSocket | Browsers (real-time PLC state updates, auto-connected) |
| 3102 | Internal HTTP broadcast | localhost only (API routes → WebSocket server) |

### Docker (Alternative)

```bash
cd docker && docker compose up -d --build
```

Runs the app on port 3000 inside a container.

## First-Time Use (Technician Workflow)

1. Open `http://SERVER_IP:3000` → log in with PIN `852963`
2. Click the **gear icon** → enter Cloud URL, Subsystem ID, API Password
3. Click **Pull IOs** to fetch I/O definitions from the cloud database
4. Switch to the **PLC Connection** tab → enter PLC IP and path → click **Connect**
   - If tags don't match the PLC program, a mismatch report is shown in the log
   - Use **Copy Report** to share the mismatch details with the PLC programmer
5. Close the config dialog → click **START** to begin testing mode
6. **Inputs**: wait for a state change → Pass/Fail dialog appears automatically
7. **Outputs**: click **FIRE** → observe the physical device → Pass/Fail
   - Click = quick pulse (ON then OFF)
   - Hold = stays ON while held, OFF on release
8. When done, click **Sync** to push results to the cloud

## User Management

The app uses PIN-based authentication. An admin can manage users via the settings.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/users` | GET | List all users (admin only) |
| `/api/users` | POST | Create user `{ name, pin, role }` (admin only) |
| `/api/users/[id]` | DELETE | Delete user (admin only) |
| `/api/users/[id]/reset-pin` | PUT | Reset PIN `{ newPin }` (admin only) |
| `/api/users/[id]/toggle-active` | PUT | Enable/disable user (admin only) |

Default admin PIN: `852963`. Roles: `admin`, `user`.

## Project Structure

```
local-tool/
├── frontend/                    # Next.js 14 — the entire application
│   ├── app/                     # Pages + API routes (all backend logic)
│   │   ├── page.tsx             # Login page (PIN entry)
│   │   ├── project/[id]/        # Project overview page
│   │   ├── commissioning/[id]/  # Main testing page
│   │   └── api/                 # REST API
│   │       ├── ios/             # I/O CRUD, test, reset, fire-output, state
│   │       ├── plc/             # PLC connect, disconnect, status, toggle-testing
│   │       ├── cloud/           # Pull IOs, sync, status
│   │       ├── auth/            # Login (PIN-only), verify
│   │       ├── configuration/   # Config CRUD, runtime, connect, logs
│   │       ├── history/         # Test history (all + per-IO)
│   │       ├── users/           # User management (CRUD, reset PIN, toggle active)
│   │       ├── simulator/       # Enable, disable, status
│   │       └── health/          # Health check
│   ├── components/              # React UI components (shadcn/ui)
│   ├── lib/                     # Core libraries
│   │   ├── plc/                 # PLC native bindings (ffi-rs + libplctag)
│   │   │   ├── libplctag.ts     # ffi-rs wrapper for libplctag C library
│   │   │   ├── plc-client.ts    # High-level PLC client (connect, read, write)
│   │   │   ├── tag-reader.ts    # Continuous 75ms tag reading loop
│   │   │   ├── websocket-client.ts  # Browser-side WebSocket hook
│   │   │   └── types.ts         # PLC types + WebSocket message types
│   │   ├── plc-client-manager.ts  # Singleton PLC client + WS broadcast helper
│   │   ├── db/                  # Prisma singleton + repositories
│   │   ├── auth/                # JWT, bcrypt, middleware helpers
│   │   ├── cloud/               # Cloud sync service
│   │   ├── config/              # Config service (file-based, hot-reload)
│   │   └── services/            # IO test service, PLC simulator
│   ├── prisma/schema.prisma     # Database schema (SQLite)
│   ├── scripts/plc-websocket-server.js  # WebSocket broadcast server
│   ├── server.js                # Production server (Next.js + WebSocket)
│   └── server.dev.js            # Development server launcher
├── deploy/                      # Factory deployment scripts
│   ├── BUILD-PORTABLE.bat       # Build portable distribution
│   ├── START.bat / STOP.bat     # Start/stop the app
│   ├── STATUS.bat               # Check status, show IPs
│   └── SETUP-FIREWALL.bat       # Open firewall ports (run once)
├── docker/                      # Docker deployment
│   ├── docker-compose.yml
│   └── Dockerfile.frontend
├── CLAUDE.md                    # Detailed architecture reference
└── README.md                    # This file
```

## Architecture

```
Factory Server (Windows PC running Node.js)
    │
    ├── Port 3000: Next.js App (production) / Port 3020 (development)
    │   ├── UI (React, Tailwind, shadcn/ui)
    │   ├── API Routes (all backend logic)
    │   ├── SQLite Database (Prisma ORM)
    │   └── PLC Communication (ffi-rs → libplctag → Ethernet/IP)
    │
    ├── Port 3002: WebSocket Server
    │   └── Broadcasts real-time PLC tag state changes
    │
    └── Port 3102: Internal HTTP Broadcast (localhost only)
        └── API routes POST here → WebSocket server fans out to browsers
                │
                ▼
        Tablets / Laptops (browser)
        http://SERVER_IP:3000
```

No external backend, no separate database server. Single Node.js process with a local SQLite file.
