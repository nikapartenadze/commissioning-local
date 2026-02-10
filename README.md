# IO Checkout Tool

Industrial I/O commissioning application for testing and validating PLC Input/Output points. Technicians use this on tablets and laptops during factory commissioning to systematically test every sensor, switch, valve, and motor.

## How It Works

1. I/O definitions are fetched from remote PostgreSQL and cached in local SQLite
2. Backend connects to PLC via Ethernet/IP (libplctag), reads tag states at 75ms intervals
3. State changes are broadcast via SignalR to all connected browsers
4. When an input transitions (FALSE -> TRUE), a dialog prompts the technician to mark Pass/Fail
5. Results are stored locally and synced to cloud (with offline queue if unavailable)

## Project Structure

```
commissioning-local/
├── backend/                 # C# ASP.NET Core (.NET 9.0)
│   ├── Controllers/         # API endpoints
│   ├── Services/            # PLC communication, sync, testing logic
│   ├── Models/              # EF Core entities, TagsContext
│   ├── config.json.template # PLC configuration template
│   └── Program.cs           # Startup and DI
├── frontend/                # Next.js 14 (React, TypeScript, Tailwind)
│   ├── app/                 # App Router pages + API proxy
│   ├── components/          # UI components (shadcn/ui)
│   └── lib/                 # SignalR client, API config, auth
├── Shared.Library/          # Shared C# models and DTOs
├── docker-compose.yml       # Docker deployment
├── create-portable-distribution.ps1  # Build portable package
└── portable/                # Pre-built distribution (not in git)
```

## Deployment Options

### Option 1: Portable Distribution (Factory Use)

Self-contained package with .NET runtime, Node.js, and pre-built apps. No installation required.

**Build it:**
```
REBUILD-DISTRIBUTION.bat
```

**Deploy it:**
1. Copy the `portable/` folder to the server (e.g., `C:\IOCheckout`)
2. Copy `backend/config.json.template` to `backend/config.json`
3. Edit `config.json` with PLC IP, path, and subsystem ID
4. Double-click `START.bat`
5. Open `http://localhost:3002` (default admin PIN: `852963`)

**Access from other computers:**
- Find server IP with `ipconfig`
- Open `http://SERVER_IP:3002` on tablets
- Open firewall ports 5000 and 3002 if needed:
  ```
  netsh advfirewall firewall add rule name="IO Checkout Backend" dir=in action=allow protocol=tcp localport=5000
  netsh advfirewall firewall add rule name="IO Checkout Frontend" dir=in action=allow protocol=tcp localport=3002
  ```

See `portable/FACTORY-SETUP.txt` for detailed step-by-step instructions.

### Option 2: Windows Services (Production Servers)

Install as Windows services that auto-start on boot and restart on crash. Uses NSSM.

```powershell
# Run as Administrator in the portable/ folder
.\service.ps1 install     # Install both services
.\service.ps1 start       # Start services
.\service.ps1 status      # Check status and port listening
.\service.ps1 stop        # Stop services
.\service.ps1 restart     # Restart services
.\service.ps1 uninstall   # Remove services
.\service.ps1 logs        # View recent logs
```

Services created:
- `IOCheckoutBackend` - .NET backend on port 5000
- `IOCheckoutFrontend` - Next.js frontend on port 3002 (depends on backend)

Logs are written to `portable/logs/`.

### Option 3: Docker

```bash
docker compose up -d
```

Backend on port 5000, frontend on port 3002. Data persisted in `backend-data` volume.

## Development

### Prerequisites

- .NET 9.0 SDK
- Node.js 20+

### Running Locally

```bash
# Terminal 1: Backend (port 5000)
cd backend && dotnet run

# Terminal 2: Frontend (port 3002)
cd frontend && npm install && npm run dev
```

Or use the batch script:
```
start-dev.bat
```

### Building

```bash
# Backend
cd backend && dotnet build

# Frontend
cd frontend && npm run build

# Run backend tests
cd "backend/IO Checkout Tool.Tests" && dotnet test
```

### PLC Simulator

For testing without physical PLC hardware:
```bash
# Enable (random state changes every 2 seconds)
curl -X POST http://localhost:5000/api/simulator/enable

# Enable with custom interval
curl -X POST "http://localhost:5000/api/simulator/enable?intervalMs=1000"

# Disable
curl -X POST http://localhost:5000/api/simulator/disable
```

## Configuration

### Backend (`backend/config.json`)

Copy `config.json.template` to `config.json`:

```json
{
  "Plc": {
    "Ip": "192.168.1.100",
    "Path": "1,0",
    "SubsystemId": "16",
    "RemoteUrl": "https://your-cloud-server.com",
    "ApiPassword": "your-api-key",
    "OrderMode": "0"
  }
}
```

| Setting | Description |
|---------|-------------|
| `Ip` | PLC IP address |
| `Path` | PLC communication path (slot/port, from controls engineer) |
| `SubsystemId` | Unique ID for this test station |
| `RemoteUrl` | Cloud sync URL (leave empty if not using) |
| `ApiPassword` | API key for cloud sync |
| `OrderMode` | `0` = test any order, `1` = sequential |

Configuration can also be managed via the UI and hot-reloaded without restart.

### Ports

| Service | Port | Purpose |
|---------|------|---------|
| Backend | 5000 | API + SignalR hub |
| Frontend | 3002 | Web UI |

## Testing Workflow

1. Log in with 6-digit PIN (default admin: `852963`)
2. Select project and subsystem
3. Click **Start Testing**
4. **Inputs**: Wait for state change (or click row to manually trigger) -> Pass/Fail dialog
5. **Outputs**: Click Fire Output -> observe physical device -> Pass/Fail
6. **Failed**: Select failure reason + optional comments -> creates diagnostic trail
7. Results sync to cloud automatically (or queue offline)
8. Export CSV for documentation

## Architecture

```
Remote PostgreSQL -> CloudSyncService -> Local SQLite
                                              |
PLC (Ethernet/IP) <-> libplctag <-> TagReaderService (75ms loop)
                                              |
                                       SignalR Hub
                                              |
                                    Browser (port 3002)
```

Frontend proxies all API calls through Next.js catch-all route to avoid CORS:
```
Browser -> /api/backend/{path} -> Next.js proxy -> http://localhost:5000/api/{path}
```

SignalR connects directly from browser to backend port 5000.
