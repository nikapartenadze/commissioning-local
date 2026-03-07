# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Industrial I/O Checkout Tool for commissioning PLC (Programmable Logic Controller) systems. Technicians use this to test and validate Input/Output points during factory commissioning.

**How it works:**
1. User opens app → sees empty state (no auto-connect, no auto-load)
2. User clicks "Pull IOs" → fetches I/O definitions from remote PostgreSQL, stores in local SQLite
3. Backend connects to PLC via libplctag (native DLL), continuously reads tag states (75ms intervals)
4. Tag states are broadcast via SignalR to frontend
5. Frontend shows real-time I/O state changes - when state transitions (FALSE→TRUE), prompts technician to mark Pass/Fail
6. Test results are stored locally and synced to remote PostgreSQL (with offline queue if cloud unavailable)

## Tech Stack

- **Backend**: .NET 9.0 (C#), ASP.NET Core, Entity Framework Core, SQLite (local), SignalR, libplctag (native P/Invoke) for Ethernet/IP PLC communication
- **Frontend**: Next.js 14, React 18, TypeScript, Tailwind CSS, shadcn/ui (Radix UI primitives), SignalR client, TanStack Virtual
- **Shared Library**: `Shared.Library/` - shared C# models (Io, TestHistory, PendingSync, Project, Subsystem, TagTypeDiagnostic), DTOs, repository interfaces
- **Remote Database**: PostgreSQL (cloud server for I/O definitions and synced results)
- **Deployment**: Docker (Linux), portable self-contained distribution (Windows)

## Common Commands

### Development (Docker - recommended for Linux)
```bash
# Start backend in Docker (port 5000)
cd docker && docker compose up -d backend

# Start frontend locally (port 3020)
cd frontend && npm run dev

# View backend logs
docker logs -f docker-backend-1
```

### Development (Windows - native)
```bash
# Start both backend and frontend
start-dev.bat

# Backend only (port 5000)
cd backend && dotnet run

# Frontend only (port 3020)
cd frontend && npm run dev
```

### Build & Test
```bash
# Backend build
cd backend && dotnet build

# Backend tests
cd "backend/IO Checkout Tool.Tests" && dotnet test

# Frontend build
cd frontend && npm run build

# Frontend lint
cd frontend && npm run lint
```

### Docker
```bash
# Build and start all services
cd docker && docker compose up -d --build

# Start only backend (expose port 5000)
cd docker && docker compose up -d backend

# Stop all
cd docker && docker compose down

# View logs
docker logs -f docker-backend-1
```

### PLC Simulator (for testing without hardware)
```bash
# Enable simulator (random I/O state changes every 2 seconds)
curl -X POST http://localhost:5000/api/simulator/enable

# Enable with custom interval (500-10000ms)
curl -X POST "http://localhost:5000/api/simulator/enable?intervalMs=1000"

# Disable simulator
curl -X POST http://localhost:5000/api/simulator/disable

# Check simulator status
curl http://localhost:5000/api/simulator/status
```

## Architecture

```
local-tool/
├── backend/                 # C# ASP.NET Core application
│   ├── Controllers/         # API endpoints (Api, Auth, Config, Simulator, Diagnostic)
│   ├── Services/            # Business logic (PLC, testing, sync, config)
│   │   ├── Interfaces/      # Service contracts
│   │   ├── PlcTags/         # Native P/Invoke layer (LibPlcTag.Native.cs, NativeTag.cs)
│   │   └── State/           # In-memory state management
│   ├── Models/              # EF Core entities and TagsContext
│   ├── Hubs/                # SignalR hub
│   └── Program.cs           # DI and startup configuration
├── frontend/                # Next.js application (port 3020)
│   ├── app/                 # App Router pages and API routes
│   │   ├── commissioning/   # Main commissioning page
│   │   └── api/backend/     # Catch-all proxy to C# backend
│   ├── components/          # React components (shadcn/ui based)
│   │   └── plc-config-dialog.tsx  # Config & Pull IOs dialog
│   └── lib/                 # Utilities (signalr-client, api-config, auth)
├── docker/                  # Docker deployment
│   ├── docker-compose.yml   # Service definitions
│   ├── Dockerfile.backend   # Backend image
│   └── Dockerfile.frontend  # Frontend image
├── Shared.Library/          # Shared C# models, DTOs, repository interfaces
└── IO-Checkout-Solution.sln # Solution file
```

## Key Architectural Patterns

### No Auto-Connect on Startup
The app does NOT auto-connect to PLC or cloud on startup. User must:
1. Open config dialog (gear icon)
2. Configure Remote URL, Subsystem ID, API Password
3. Click "Pull IOs" to fetch data from cloud
4. SignalR connects only after successful data pull

### Frontend Proxy Pattern
All frontend API calls go through a catch-all Next.js API route that proxies to the C# backend:
```
Browser → /api/backend/{path} → Next.js proxy → http://localhost:5000/api/{path}
```
This eliminates CORS issues. The proxy is at `frontend/app/api/backend/[...path]/route.ts`.

### SignalR Hub
Hub URL: `/hub` (proxied through Next.js custom server to avoid exposing backend port)
- `UpdateState(id, state)` - PLC state changes (TRUE/FALSE)
- `UpdateIO(id, result, state, timestamp, comments)` - Test result updates
- SignalR does NOT auto-connect - connects only after user pulls IOs
- Direct backend connection: `http://localhost:5000/hub` (for debugging)

### Config Hot-Reload
Backend watches `config.json` via `ConfigFileWatcherService`. Editing the file triggers automatic reinitialization without restart.

### Pull IOs Flow
```
User clicks "Pull IOs"
    ↓
Frontend calls POST /api/backend/cloud/pull
    ↓
Backend updates config (remoteUrl, apiPassword, subsystemId)
    ↓
Backend calls TriggerFreshSyncAsync(skipPlcInitialization: true)
    ↓
Fetches IOs from cloud PostgreSQL
    ↓
Stores in local SQLite
    ↓
Refreshes in-memory TagList (NO PLC connection)
    ↓
Frontend calls loadIos() to refresh UI
    ↓
SignalR connects for real-time updates
```

## Data Flow

```
Remote PostgreSQL → CloudSyncService → Local SQLite (Ios table)
                                            ↓
                                 PlcCommunicationService
                                            ↓
PLC (Ethernet/IP) ↔ plctag.dll ↔ TagReaderService (continuous read loop)
                                            ↓
                                 SignalR Hub broadcasts state
                                            ↓
                                 Frontend receives UpdateState/UpdateIO
                                            ↓
                                 UI shows state change → Test dialog
                                            ↓
                                 Technician marks Pass/Fail
                                            ↓
                            API updates SQLite + syncs to PostgreSQL
```

## Key Backend Services

| Service | Responsibility |
|---------|----------------|
| `PlcCommunicationService` | Entry point for PLC ops, manages tag lifecycle, in-memory state cache |
| `TagReaderService.Native` | High-performance parallel tag reading (batches of 25, 6 concurrent readers) |
| `ResilientCloudSyncService` | Real-time sync + offline queue (PendingSyncs table) |
| `IoTestService` | Test result recording, creates TestHistory audit trail |
| `SignalRService` | Broadcasts state/result updates to all connected browsers |
| `ConfigurationService` | Runtime config management, `UpdateCloudSettingsAsync()` for lightweight config updates |
| `PlcSimulatorService` | Simulates PLC tag state changes for testing without hardware |

## Database

### Local SQLite (`backend/database.db`)
- **Ios**: I/O definitions with Result, Timestamp, Comments, TagType (State is NOT persisted - always live from PLC)
- **TestHistories**: Audit trail of all test results
- **TagTypeDiagnostics**: Diagnostic help data for tag types
- **PendingSyncs**: Offline queue for cloud sync when disconnected
- **Users**: PIN-based auth with BCrypt hashing

## Configuration

### Backend (`backend/config.json`)
```json
{
  "ip": "192.168.1.100",
  "path": "1,0",
  "remoteUrl": "https://commissioning.lci.ge",
  "ApiPassword": "",
  "subsystemId": "16",
  "orderMode": "0",
  "syncBatchSize": 50,
  "syncBatchDelayMs": 500
}
```
| Setting | Description |
|---------|-------------|
| `orderMode` | `0` = test any order, `1` = sequential testing |
| `syncBatchSize` | Number of records per cloud sync batch |
| `syncBatchDelayMs` | Delay between sync batches |

Copy `config.json.template` to `config.json` for first-time setup.

### Ports
- **Backend**: 5000
- **Frontend**: 3020 (dev), 3000 (Docker), 3002 (portable production)

### Frontend Config
Backend URL configured in `frontend/lib/api-config.ts`:
- `BACKEND_PORT = 5000`
- `getBackendUrl()` returns `http://localhost:5000` (or `BACKEND_URL` env var in Docker)

## Important Caveats

- **libplctag native library**: Backend requires `plctag.dll` (Windows) or `libplctag.so` (Linux). On Linux, use Docker which includes the library.
- **No auto-connect**: App intentionally does NOT auto-connect on startup. User must explicitly pull IOs.
- **SignalR lazy connect**: SignalR only connects after successful Pull IOs, not on page load.
- **TagType for Help buttons**: Help buttons only appear when IO has `tagType` set. This is local-only, not synced from cloud.

## Testing Workflow

1. **Configure**: Open config dialog → set Remote URL, Subsystem ID, API Password
2. **Pull IOs**: Click "Pull IOs" → fetches from cloud
3. **Test Inputs**: Wait for state transition (FALSE→TRUE) → Dialog appears → Mark Pass/Fail
4. **Test Outputs**: Click "Fire Output" → Backend writes to PLC → Observe physical response → Mark Pass/Fail
5. Results sync to cloud (or queued if offline)

## Factory Deployment (Windows)

The `IO-Checkout-Tool-Portable/` folder contains pre-built distribution:
- Self-contained .NET backend (no .NET install required)
- Pre-built Next.js frontend with standalone server
- Portable Node.js runtime included
- START.bat / STOP.bat / STATUS.bat scripts

Build with: `REBUILD-DISTRIBUTION.bat`

### Windows Services (Production)
Install as auto-starting Windows services using NSSM:
```powershell
# Run as Administrator in portable/ folder
.\service.ps1 install     # Install both services
.\service.ps1 start       # Start services
.\service.ps1 status      # Check status
.\service.ps1 stop        # Stop services
.\service.ps1 uninstall   # Remove services
```

### Backend CLI Flags
```bash
# Allow multiple instances (bypasses single-instance check)
dotnet run -- --allow-multiple-instances

# Seed database with 1000 test tags (for testing)
dotnet run -- --seed-database
```

## Authentication
- PIN-based login (6-digit codes)
- Default admin PIN: `852963`
- JWT tokens for API authentication
- Rate limiting: 5 login attempts per minute
