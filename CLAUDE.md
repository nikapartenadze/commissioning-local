# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Industrial I/O Checkout Tool for commissioning PLC (Programmable Logic Controller) systems. Technicians use this to test and validate Input/Output points during factory commissioning.

**How it works:**
1. I/O definitions are fetched from remote PostgreSQL database and cached in local SQLite
2. Backend connects to PLC via libplctag, continuously reads tag states (75ms intervals)
3. Tag states are matched to I/O definitions and broadcast via SignalR to frontend
4. Frontend shows real-time I/O state changes - when state transitions (FALSE→TRUE), prompts technician to mark Pass/Fail
5. Test results are stored locally and synced to remote PostgreSQL (with offline queue if cloud unavailable)

## Tech Stack

- **Backend**: .NET 9.0 (C#), ASP.NET Core, Entity Framework Core, SQLite (local), SignalR, libplctag for Ethernet/IP PLC communication
- **Frontend**: Next.js 14, React 18, TypeScript, Tailwind CSS, shadcn/ui, Zustand, SignalR client
- **Remote Database**: PostgreSQL (cloud server for I/O definitions and synced results)
- **Deployment**: Docker, Drone CI

## Common Commands

### Development
```bash
# Start both backend and frontend
start-dev.bat

# Backend only (port 5000)
cd backend && dotnet run

# Frontend only (port 3000)
cd frontend && npm run dev
```

### Build & Test
```bash
# Backend build
cd backend && dotnet build

# Frontend build
cd frontend && npm run build

# Frontend linting
cd frontend && npm run lint

# Run backend tests
cd backend && dotnet test
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
│   ├── Controllers/         # API endpoints
│   ├── Services/            # Business logic (PLC, testing, sync)
│   ├── Models/              # EF Core entities
│   ├── Repositories/        # Data access layer
│   ├── Hubs/                # SignalR hub
│   └── Program.cs           # DI and startup configuration
├── frontend/                # Next.js application
│   ├── app/                 # App Router pages and API routes
│   ├── components/          # React components
│   ├── lib/                 # Utilities (signalr-client)
│   └── types/               # TypeScript definitions
└── Shared.Library/          # Shared C# models and DTOs
```

## Data Flow

```
Remote PostgreSQL → CloudSyncService → Local SQLite (Ios table)
                                              ↓
                                   PlcCommunicationService
                                              ↓
PLC (Ethernet/IP) ←→ libplctag.dll ←→ TagReaderService (continuous read loop)
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
| `PlcCommunicationService.cs` | Entry point for PLC ops, manages tag lifecycle, in-memory state cache |
| `TagReaderService.Native.cs` | High-performance parallel tag reading (batches of 25, 6 concurrent readers) |
| `PlcTagFactoryService.cs` | Creates NativeTag objects from I/O definitions |
| `PlcSimulatorService.cs` | Simulates PLC tag state changes for testing without hardware |
| `IoTestService.cs` | Test result recording, creates TestHistory audit trail |
| `SignalRService.cs` | Broadcasts state/result updates to all connected browsers |
| `ResilientCloudSyncService.cs` | Real-time sync + offline queue (PendingSyncs table) |
| `CloudSyncService.cs` | Fetches I/O definitions from remote PostgreSQL |

## Key Frontend Files

| File | Purpose |
|------|---------|
| `app/page.tsx` | Dashboard with PIN login |
| `app/commissioning/[id]/page.tsx` | Main testing interface, SignalR subscription, dialog queue |
| `components/enhanced-io-data-grid.tsx` | Virtualized I/O grid (TanStack Virtual for 1000+ items) |
| `lib/signalr-client.ts` | SignalR connection with auto-reconnect |

## Database

### Local SQLite (`backend/database.db`)
- **Ios**: I/O definitions with Result, Timestamp, Comments (State is NOT persisted - always live from PLC)
- **TestHistories**: Audit trail of all test results (who, when, what, comments)
- **TagTypeDiagnostics**: Diagnostic data for tag types (linked to Ios for failure analysis)
- **PendingSyncs**: Offline queue for cloud sync when disconnected
- **SubsystemConfigurations**: Multi-PLC/project support
- **Users**: PIN-based auth with BCrypt hashing

SQLite optimized with WAL mode for multi-user concurrent access.

### Remote PostgreSQL
- Source of truth for I/O definitions
- Receives synced test results
- Accessed via `/api/sync/update` endpoint with API key auth

## API Endpoints (Backend port 5000)

```
GET  /api/ios                    → All IOs with live states
GET  /api/ios/subsystem/{id}     → IOs for specific subsystem
POST /api/ios/{id}/pass          → Mark IO passed
POST /api/ios/{id}/fail          → Mark IO failed
POST /api/ios/{id}/clear         → Clear test result
GET  /api/ios/{id}/history       → Test history for IO
POST /api/plc/test-connection    → Test PLC connectivity
GET  /api/status                 → System status + PLC connection
POST /api/auth/login             → PIN authentication
POST /api/sync/update            → Cloud sync endpoint

# Simulator endpoints (testing without PLC)
POST /api/simulator/enable       → Enable PLC simulator
POST /api/simulator/disable      → Disable PLC simulator
GET  /api/simulator/status       → Check simulator status

# Diagnostics endpoints
GET  /api/diagnostic/tagtypes              → All tag type diagnostics
GET  /api/diagnostic/tagtypes/{id}         → Diagnostic by ID
GET  /api/diagnostic/tagtypes/search/{tag} → Search by tag name
```

### SignalR Hub (`/signalr`)
- `UpdateState(id, state)` - PLC state changes (TRUE/FALSE)
- `UpdateIO(id, result, state, timestamp, comments)` - Test result updates

## Configuration

### Backend (`backend/config.json`)
```json
{
  "Plc": {
    "Ip": "192.168.1.100",        // PLC IP address
    "Path": "1,0",                 // Ethernet/IP path
    "SubsystemId": "16",           // Subsystem/project ID
    "RemoteUrl": "https://...",    // Cloud server URL
    "ApiPassword": "secret",       // API key for cloud sync
    "OrderMode": "0"               // Sequential testing mode
  }
}
```
Copy `config.json.template` to `config.json` for first-time setup.

### Frontend
Backend URL hardcoded to `http://localhost:5000`

## Testing Workflow

1. **Input Points**: Wait for state transition (FALSE→TRUE) → Dialog appears → Mark Pass/Fail
2. **Output Points**: Click "Fire Output" → Backend writes to PLC → Observe physical response → Mark Pass/Fail
3. All results create audit trail in TestHistories
4. Real-time sync to cloud (or queued if offline)

## Ports

- Backend: `5000`
- Frontend: `3000`

## Factory Deployment

The `IO-Checkout-Tool-Portable/` folder contains pre-built distribution:
- Self-contained .NET backend (no .NET install required)
- Pre-built Next.js frontend with standalone server
- Portable Node.js runtime included
- START.bat and STOP.bat scripts

### Building Portable Distribution
```bash
REBUILD-DISTRIBUTION.bat
```

### Multi-User Support
- Multiple users can test simultaneously via SignalR
- All connected browsers see live updates instantly
- SQLite WAL mode handles concurrent writes
