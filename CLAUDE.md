# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Industrial I/O Checkout Tool for commissioning PLC (Programmable Logic Controller) systems. Technicians use this to test and validate Input/Output points during factory commissioning.

**How it works:**
1. I/O definitions are fetched from remote PostgreSQL database and cached in local SQLite
2. Backend connects to PLC via libplctag (native DLL, P/Invoke), continuously reads tag states (75ms intervals)
3. Tag states are matched to I/O definitions and broadcast via SignalR to frontend
4. Frontend shows real-time I/O state changes - when state transitions (FALSE->TRUE), prompts technician to mark Pass/Fail
5. Test results are stored locally and synced to remote PostgreSQL (with offline queue if cloud unavailable)

## Tech Stack

- **Backend**: .NET 9.0 (C#), ASP.NET Core, Entity Framework Core, SQLite (local), SignalR, libplctag (native P/Invoke) for Ethernet/IP PLC communication, MudBlazor (Razor components for legacy UI)
- **Frontend**: Next.js 14, React 18, TypeScript, Tailwind CSS, shadcn/ui (Radix UI primitives), Zustand, SignalR client, TanStack Table + Virtual
- **Shared Library**: `Shared.Library/` - shared C# models (entities: Io, TestHistory, PendingSync, Project, Subsystem, TagTypeDiagnostic), DTOs, repository interfaces
- **Remote Database**: PostgreSQL (cloud server for I/O definitions and synced results)
- **Deployment**: Docker, Drone CI, portable self-contained distribution (Windows)

## Common Commands

### Development
```bash
# Start both backend and frontend
start-dev.bat

# Backend only (port 5000)
cd backend && dotnet run

# Frontend only (port 3002)
cd frontend && PORT=3002 npm run dev
```

### Build & Test
```bash
# Backend build
cd backend && dotnet build

# Backend tests
cd "backend/IO Checkout Tool.Tests" && dotnet test

# Frontend build
cd frontend && npm run build

# Frontend linting
cd frontend && npm run lint
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
commissioning-local/
├── backend/                 # C# ASP.NET Core application
│   ├── Controllers/         # API endpoints (Api, Auth, Config, Simulator, Diagnostic, etc.)
│   ├── Services/            # Business logic (PLC, testing, sync, config)
│   │   ├── Interfaces/      # Service contracts
│   │   ├── PlcTags/         # Native P/Invoke layer (LibPlcTag.Native.cs, NativeTag.cs)
│   │   └── State/           # In-memory state management (AppStateService, TestState, etc.)
│   ├── Models/              # EF Core entities and TagsContext
│   ├── Repositories/        # Data access layer
│   ├── Hubs/                # SignalR hub
│   ├── Extensions/          # DI registration extensions
│   ├── Components/          # MudBlazor Razor components (legacy UI)
│   └── Program.cs           # DI and startup configuration
├── frontend/                # Next.js application
│   ├── app/                 # App Router pages and API routes
│   │   └── api/backend/[...path]/ # Catch-all proxy to C# backend
│   ├── components/          # React components (shadcn/ui based)
│   ├── lib/                 # Utilities (signalr-client, api-config, auth)
│   └── types/               # TypeScript definitions
├── Shared.Library/          # Shared C# models, DTOs, repository interfaces
└── IO-Checkout-Solution.sln # Solution file (includes IO-Checkout-Cloud project)
```

## Key Architectural Patterns

### Frontend Proxy Pattern
All frontend API calls go through a catch-all Next.js API route that proxies to the C# backend:
```
Browser -> /api/backend/{path} -> Next.js proxy -> http://localhost:5000/api/{path}
```
This eliminates CORS issues. The proxy is at `frontend/app/api/backend/[...path]/route.ts`. API endpoints are centralized in `frontend/lib/api-config.ts` (see `API_ENDPOINTS` object).

### SignalR Hub
The hub URL is `/hub` (not `/signalr`). SignalR connects directly from browser to backend port 5000 (bypasses the Next.js proxy). Connection logic is in `frontend/lib/signalr-client.ts`.
- `UpdateState(id, state)` - PLC state changes (TRUE/FALSE)
- `UpdateIO(id, result, state, timestamp, comments)` - Test result updates

### Config Hot-Reload
Backend watches `config.json` via `ConfigFileWatcherService`. Editing the file triggers automatic reinitialization (PLC reconnect, cloud sync refresh) without restarting the app. The frontend polls `/api/backend/configuration/runtime` for dynamic config and shows a `config-reload-banner` component during reloads.

### Startup Coordination
`StartupCoordinationService` orchestrates boot order: Database init -> Cloud sync (fetch I/O definitions) -> PLC initialization -> Offline sync processing -> Config file watcher. See `backend/Services/*HostedService.cs` files.

### PLC Communication Layer
Uses native P/Invoke to `plctag.dll` (not the NuGet package). The call chain is:
- `PlcCommunicationService` (orchestrator, in-memory state cache)
- `TagReaderService.Native.cs` (parallel reading: batches of 25, 6 concurrent readers)
- `PlcTags/LibPlcTag.Native.cs` (raw P/Invoke declarations)
- `PlcTags/NativeTag.cs` (safe wrapper around native tag handles)

## Data Flow

```
Remote PostgreSQL -> CloudSyncService -> Local SQLite (Ios table)
                                              |
                                   PlcCommunicationService
                                              |
PLC (Ethernet/IP) <-> plctag.dll <-> TagReaderService (continuous read loop)
                                              |
                                   SignalR Hub broadcasts state
                                              |
                                   Frontend receives UpdateState/UpdateIO
                                              |
                                   UI shows state change -> Test dialog
                                              |
                                   Technician marks Pass/Fail
                                              |
                              API updates SQLite + syncs to PostgreSQL
```

## Key Backend Services

| Service | Responsibility |
|---------|----------------|
| `PlcCommunicationService` | Entry point for PLC ops, manages tag lifecycle, in-memory state cache |
| `TagReaderService.Native` | High-performance parallel tag reading (batches of 25, 6 concurrent readers) |
| `PlcTagFactoryService` | Creates NativeTag objects from I/O definitions |
| `PlcSimulatorService` | Simulates PLC tag state changes for testing without hardware |
| `IoTestService` | Test result recording, creates TestHistory audit trail |
| `SignalRService` | Broadcasts state/result updates to all connected browsers |
| `ResilientCloudSyncService` | Real-time sync + offline queue (PendingSyncs table) |
| `CloudSyncService` | Fetches I/O definitions from remote PostgreSQL |
| `ConfigurationService` | Runtime config management, supports hot-switching subsystems without restart |
| `ConfigFileWatcherService` | Monitors config.json for external changes, triggers reinitialization |
| `StartupCoordinationService` | Orchestrates service initialization order at boot |
| `WatchdogService` | PLC connection health monitoring |
| `AppStateService` | Centralized in-memory state (UI, filter, test, graph states) |

## Database

### Local SQLite (`backend/database.db`)
- **Ios**: I/O definitions with Result, Timestamp, Comments (State is NOT persisted - always live from PLC)
- **TestHistories**: Audit trail of all test results (who, when, what, comments)
- **TagTypeDiagnostics**: Diagnostic data for tag types (linked to Ios for failure analysis)
- **PendingSyncs**: Offline queue for cloud sync when disconnected
- **SubsystemConfigurations**: Multi-PLC/project support with runtime switching
- **Users**: PIN-based auth with BCrypt hashing

SQLite optimized with WAL mode for multi-user concurrent access.

## Configuration

### Backend (`backend/config.json`)
```json
{
  "Plc": {
    "Ip": "192.168.1.100",
    "Path": "1,0",
    "SubsystemId": "16",
    "RemoteUrl": "https://...",
    "ApiPassword": "secret",
    "OrderMode": "0"
  }
}
```
Copy `config.json.template` to `config.json` for first-time setup. Configuration can also be managed via the UI (stored in SubsystemConfigurations table) and switched at runtime without restarting.

### Frontend
Backend URL hardcoded to `http://localhost:5000` in `frontend/lib/api-config.ts` and `frontend/app/api/backend/[...path]/route.ts`. Ports: backend 5000, frontend 3002.

## Testing Workflow

1. **Input Points**: Wait for state transition (FALSE->TRUE) -> Dialog appears -> Mark Pass/Fail
2. **Output Points**: Click "Fire Output" -> Backend writes to PLC -> Observe physical response -> Mark Pass/Fail
3. All results create audit trail in TestHistories
4. Real-time sync to cloud (or queued if offline)

## Factory Deployment

The `portable/` folder contains pre-built distribution:
- Self-contained .NET backend (no .NET install required)
- Pre-built Next.js frontend with standalone server
- Portable Node.js runtime included
- START.bat / STOP.bat / STATUS.bat scripts

Build with: `REBUILD-DISTRIBUTION.bat`
