# IO Checkout Tool

Industrial I/O commissioning application for testing and validating PLC Input/Output points. Technicians use this on tablets and laptops during factory commissioning to systematically test every sensor, switch, valve, and motor.

## How It Works

1. Admin pulls I/O definitions from remote PostgreSQL — cached locally in SQLite
2. App connects to PLC via libplctag (ffi-rs), reads tag states at 75ms intervals
3. State changes are broadcast via WebSocket to all connected browsers in real-time
4. When an input transitions (FALSE → TRUE), a dialog prompts the technician to mark Pass/Fail
5. Failed tests show diagnostic troubleshooting steps (Help button) based on device type
6. Results sync to cloud instantly on every action, with 30s background retry as fallback
7. Other technicians' results merge into your view every 60 seconds

## Prerequisites

**For factory deployment:** None — the portable build bundles everything (Node.js, plctag.dll).

**For development:** Node.js 20+ ([download](https://nodejs.org)) and `libplctag.so` on Linux ([releases](https://github.com/libplctag/libplctag/releases)).

## Development

All source code lives in the `frontend/` directory. There is no separate backend — everything runs as a single Next.js application with an embedded WebSocket server.

### First-Time Setup

```bash
cd frontend
cp env.example .env.local   # Create local environment config
npm install                  # Install deps + generate Prisma client
npx prisma db push           # Create SQLite database from schema
```

Optional — seed data for testing specific features:
```bash
npm run seed:diagnostics     # Seed diagnostic troubleshooting steps (for Help buttons)
npm run seed:network         # Seed network topology test data (for Network page)
```

### Starting the Dev Server

```bash
cd frontend
npm run dev
```

This runs `server.dev.js` which starts **three services** together:

| Service | Port | Binds to | Purpose |
|---------|------|----------|---------|
| Next.js dev server + WebSocket | 3020 | `0.0.0.0` (all interfaces) | UI + API routes + hot reload + real-time PLC state broadcasts (/ws path) |
| Internal broadcast HTTP | 3102 | `127.0.0.1` (localhost only) | API routes push messages to WebSocket server |

**Important:** The dev server binds to `0.0.0.0`, which means other devices on your network can connect. Open `http://YOUR_IP:3020` on tablets/laptops.

To find your IP address:
- **Linux:** `ip addr` or `hostname -I`
- **Windows:** `ipconfig`

#### Alternative dev commands

| Command | What it does |
|---------|-------------|
| `npm run dev` | Starts all services (recommended) |
| `npm run dev:next` | Starts only Next.js on port 3020 (no real-time PLC updates) |
| `npm run dev:ws` | Starts only the WebSocket server |

### Environment Variables

Copy `env.example` to `.env.local` and edit as needed:

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `file:./database.db` | SQLite database path |
| `JWT_SECRET_KEY` | — | Secret for signing auth tokens (change in production) |
| `WS_BROADCAST_URL` | `http://localhost:3102/broadcast` | Internal HTTP broadcast endpoint |
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

## Production Deployment (Windows Factory PCs)

The app is deployed as a **portable folder** — copy to the server, double-click `START.bat`. No installs required on the target machine. Node.js, plctag.dll, and all dependencies are bundled.

### Building the Portable Distribution

On any Windows PC with internet access (or Node.js installed):

```
deploy\BUILD-PORTABLE.bat
```

The script automatically downloads and bundles:
- **Node.js runtime** (portable, no installer)
- **plctag.dll** (PLC native library)
- All npm dependencies, Prisma client, Next.js standalone build

### Deploying to the Factory Server

1. Download the release zip and unzip it to any folder (e.g., `C:\IOCheckout`)
2. Double-click `START.bat`

That's it. Each technician can run their own copy — no dedicated server needed. On first run, START.bat automatically:
- Opens firewall port 3000 (prompts for admin permission once)
- Starts the app (database, admin user, and diagnostic data are created on first login)

### Running in Production

| Script | What it does |
|--------|-------------|
| `START.bat` | Starts the app (close the window to stop) |
| `STATUS.bat` | Shows if running, prints tablet access URLs |
| `SETUP-FIREWALL.bat` | Open firewall ports (auto-runs on first start) |
| `SEED-NETWORK.bat` | Load network topology test data (optional) |

Technicians open `http://SERVER_IP:3000` on their tablets (run `STATUS.bat` to see the IP).

### Changing the Admin PIN

The default admin account is created on first launch with PIN `111111`. To change it:

1. Log in with PIN `111111`
2. Open the **user menu** (top-right) → **Manage Users**
3. Find the "Admin" user → click **Reset PIN** → enter a new 6-digit PIN

Admins can also create additional admin or technician accounts from the same panel.

### Production Ports

| Port | Binds to | Purpose | Who connects |
|------|----------|---------|-------------|
| 3000 | `0.0.0.0` | Web UI + API + WebSocket (/ws path) | Technicians (tablets/laptops) |
| 3102 | `127.0.0.1` | Internal HTTP broadcast | localhost only — API routes push messages here, WebSocket server fans them out |

**Note:** Port 3102 should NOT be opened in the firewall — it's internal only. WebSocket connections are upgraded on port 3000 via the `/ws` path.

### Docker (Alternative)

```bash
cd docker && docker compose up -d --build
```

Runs the app on port 3000 inside a container.

## First-Time Use

### Admin Setup (one-time, from one device)

1. Open `http://SERVER_IP:3000` (production) or `http://SERVER_IP:3020` (dev) → log in with PIN `111111`
2. **Change the admin PIN** — open user menu (top-right) → Manage Users → Reset PIN on the Admin account
3. Click the **PLC** button (top-right) → enter Cloud URL, Subsystem ID, API Password
4. Click **Pull IOs** to fetch I/O definitions from the cloud database
   - Tag types are automatically assigned from IO descriptions (enables Help buttons)
5. Switch to the **PLC Connection** tab → enter PLC IP and path → click **Connect**
   - If tags don't match the PLC program, a mismatch report is shown in the log
   - Use **Copy Report** to share the mismatch details with the PLC programmer
6. Create user accounts for each technician (Settings → Users → add name + 6-digit PIN)
7. Share the server URL and PINs with the team
8. All connected browsers will automatically see the PLC connection and IO data — no refresh needed

### Technician Workflow (multiple users, simultaneously)

1. Open `http://SERVER_IP:3000` on tablet/laptop → log in with your PIN
2. PLC connection is already established (green PLC icon in toolbar) — no setup needed
3. Click **START** to begin your testing session (each user has independent start/stop)
4. **Testing Inputs:** wait for a state change → Pass/Fail dialog appears automatically
5. **Testing Outputs:** click **FIRE** → observe the physical device → Pass/Fail
   - Click = quick pulse (ON then OFF)
   - Hold = stays ON while held, OFF on release
6. **Failed tests:** select a failure mode → click the **?** Help button for troubleshooting steps
7. Your name is recorded with every Pass/Fail in the test history

### Multi-User Architecture

**Single server mode:** 5+ technicians connect to one server from different tablets/laptops.

**Multi-server mode:** Each technician runs their own portable copy. No dedicated server needed. Results sync via cloud:
- Push: instant on every action + 30s background fallback
- Pull: every 60 seconds, other users' results merge into your view
- Your results are never overwritten by cloud — local always takes priority
- See `SYNC-ARCHITECTURE.md` for full details

**Common to both modes:**
- Each user has their own START/STOP testing state (one person stopping doesn't affect others)
- All users see real-time PLC tag states via WebSocket
- Firing outputs is safe for concurrent use (per-tag write handles, no shared state)
- Test results record who tested each I/O point (`testedBy` field in history)
- PLC auto-reconnects every 5 seconds on connection loss — no admin intervention needed
- Cloud config (URL, password, subsystem) persists across restarts

### Role Permissions

| Action | Admin | User |
|--------|-------|------|
| View PLC tag states | Yes | Yes |
| Start/Stop testing | Yes | Yes |
| Mark Pass/Fail | Yes | Yes |
| Fire outputs | Yes | Yes |
| View diagnostic help | Yes | Yes |
| Export CSV / View history | Yes | Yes |
| Connect/Disconnect PLC | Yes | No |
| Pull IOs from cloud | Yes | No |
| Sync results to cloud | Yes | No |
| Manage users | Yes | No |
| Change configuration | Yes | No |

## User Management

The app uses PIN-based authentication. An admin can manage users via the settings.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/users` | GET | List all users (admin only) |
| `/api/users` | POST | Create user `{ name, pin, role }` (admin only) |
| `/api/users/[id]` | DELETE | Delete user (admin only) |
| `/api/users/[id]/reset-pin` | PUT | Reset PIN `{ newPin }` (admin only) |
| `/api/users/[id]/toggle-active` | PUT | Enable/disable user (admin only) |

Default admin PIN: `111111` (change it on first login via Manage Users → Reset PIN). Roles: `admin`, `user`.

## Architecture

```
Factory Server (Windows PC or Linux, running Node.js)
┌──────────────────────────────────────────────────────┐
│                                                      │
│  Port 3000 (prod) / 3020 (dev): Next.js App          │
│  ├── React UI (Tailwind, shadcn/ui)                  │
│  ├── API Routes (all backend logic)                  │
│  ├── SQLite Database (Prisma ORM)                    │
│  └── PLC Client (ffi-rs → libplctag → Ethernet/IP)  │
│         │ reads tags every 75ms                      │
│         │                                            │
│  Port 3000/ws: WebSocket (upgraded HTTP connections)  │
│  └── Broadcasts tag state changes to all browsers    │
│         ▲                                            │
│         │ HTTP POST                                  │
│  Port 3102: Internal Broadcast API (localhost only)  │
│  └── API routes push here → WS server fans out      │
│                                                      │
└──────────────────────────────────────────────────────┘
         │ http + ws
         ▼
┌──────────────────────┐
│ Tablets / Laptops    │
│ http://SERVER_IP:3000│
│ (browser only)       │
└──────────────────────┘
```

**Single process.** No external backend, no separate database server. One Node.js process with a local SQLite file runs everything.

## Real-Time Communication Flow

```
PLC (Ethernet/IP)
  ↓ libplctag reads (75ms loop)
Tag Reader (server-side)
  ↓ state change detected
API Route calls POST http://localhost:3102/broadcast
  ↓
WebSocket Server (port 3000/ws)
  ↓ fans out to all connected browsers
Browser A, Browser B, Browser C...
  ↓ React state update
UI shows new tag state instantly
```

Admin actions (PLC connect/disconnect, cloud pull, testing state changes) also broadcast through the same WebSocket pipeline so all clients stay in sync.

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
│   │       ├── diagnostics/     # Failure modes, troubleshooting steps
│   │       ├── history/         # Test history (all + per-IO + export)
│   │       ├── users/           # User management (CRUD, reset PIN, toggle active)
│   │       ├── simulator/       # Enable, disable, status
│   │       └── health/          # Health check
│   ├── components/              # React UI components (shadcn/ui)
│   ├── lib/                     # Core libraries
│   │   ├── plc/                 # PLC native bindings (ffi-rs + libplctag)
│   │   │   ├── libplctag.ts     # ffi-rs wrapper for libplctag C library
│   │   │   ├── plc-client.ts    # High-level PLC client (connect, read, write)
│   │   │   ├── tag-reader.ts    # Continuous 75ms tag reading loop + DINT grouping
│   │   │   ├── websocket-client.ts  # Browser-side WebSocket hook
│   │   │   └── types.ts         # PLC types + WebSocket message types
│   │   ├── plc-client-manager.ts  # Singleton PLC client + WS broadcast helper
│   │   ├── db/                  # Prisma singleton + repositories
│   │   ├── auth/                # JWT, bcrypt, middleware helpers
│   │   ├── cloud/               # Cloud sync service
│   │   ├── config/              # Config service (file-based, hot-reload)
│   │   └── services/            # IO test service, PLC simulator
│   ├── prisma/
│   │   ├── schema.prisma        # Database schema (SQLite)
│   │   ├── seed-diagnostics.ts  # Seed diagnostic troubleshooting data
│   │   └── assign-tag-types.ts  # Classify IOs by description → tagType
│   ├── scripts/
│   │   └── plc-websocket-server.js  # WebSocket broadcast server (dev mode)
│   ├── server.js                # Production server (Next.js + WebSocket + broadcast)
│   └── server.dev.js            # Dev server (spawns Next.js + WebSocket as children)
├── deploy/                      # Factory deployment scripts
│   ├── BUILD-PORTABLE.bat       # Build portable distribution
│   └── SETUP-FIREWALL.bat       # Open firewall ports (bundled into portable)
├── docker/                      # Docker deployment
│   ├── docker-compose.yml
│   └── Dockerfile.frontend
├── CLAUDE.md                    # Detailed architecture reference (for AI tools)
├── SYNC-ARCHITECTURE.md         # Sync architecture & data persistence report
├── TEST-PLAN.md / .html / .xlsx # Field test plan (multiple formats)
└── README.md                    # This file
```

## Troubleshooting

### Dev server won't start — "EADDRINUSE"
A previous server instance is still holding the port. Kill it:
```bash
# Linux
fuser -k 3020/tcp

# Windows
netstat -ano | findstr :3020
taskkill /PID <PID> /F
```

### Other devices can't connect
- Make sure you're using the server's **IP address**, not `localhost`
- Check firewall: port 3000 (or 3020 dev) must be open
- Run `STATUS.bat` (Windows) or `ip addr` (Linux) to find the server IP

### PLC tag mismatch errors
- "Bad parameter" = tag address syntax is invalid for this PLC module
- "Not found" = tag name doesn't exist in the PLC program
- Use **Copy Report** to share the full mismatch list with the PLC programmer

### Help buttons don't appear
Tag types must be assigned. This happens automatically on cloud pull. To manually assign:
```bash
cd frontend
npx tsx prisma/assign-tag-types.ts
```

### WebSocket disconnects / "Connection lost" banner
The browser WebSocket auto-reconnects. If it persists:
- Check that the WebSocket server is running (same port as the app, /ws path)
- Check browser console for errors
- Restart the dev server: kill all node processes, then `npm run dev`
