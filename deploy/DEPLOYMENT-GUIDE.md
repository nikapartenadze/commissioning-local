# IO Checkout Tool - Deployment Guide

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        TECHNICIAN'S LAPTOP                                  │
│                                                                             │
│   ┌─────────────────────┐         ┌─────────────────────┐                  │
│   │   C# Backend        │◄───────▶│   Next.js Frontend  │                  │
│   │   Port 5000         │ SignalR │   Port 3000         │                  │
│   │                     │         │                     │                  │
│   │   • SQLite DB       │         │   • React UI        │                  │
│   │   • SignalR Hub     │         │   • Serves HTML/JS  │                  │
│   │   • PLC via libplctag        │                     │                  │
│   └──────────┬──────────┘         └──────────┬──────────┘                  │
│              │                               │                              │
│              │ Ethernet/IP                   │ HTTP + WebSocket             │
│              ▼                               ▼                              │
│         ┌─────────┐                   ┌─────────────┐                      │
│         │   PLC   │                   │ WiFi Network│                      │
│         └─────────┘                   └──────┬──────┘                      │
│                                              │                              │
└──────────────────────────────────────────────┼──────────────────────────────┘
                                               │
              ┌────────────────────────────────┼────────────────────────┐
              │                                │                        │
         ┌────▼────┐      ┌──────────┐    ┌───▼─────┐                  │
         │ Phone 1 │      │ Phone 2  │    │ Tablet  │   Electricians   │
         │ Browser │      │ Browser  │    │ Browser │   connect via IP │
         └─────────┘      └──────────┘    └─────────┘
```

## Deployment Options Comparison

| Aspect | Native Windows (Recommended) | Docker |
|--------|------------------------------|--------|
| **Startup Time** | ~3 seconds | ~15-20 seconds |
| **Memory Usage** | ~150MB | ~400MB+ |
| **PLC Latency** | <5ms | 10-20ms (container NAT) |
| **Complexity** | Double-click START.bat | Docker knowledge required |
| **Debugging** | Easy (native tools) | Complex (container logs) |
| **Offline Support** | Works offline | Needs Docker daemon |
| **Field-Friendly** | Yes | No |

### Why Native Windows is Better for This Use Case

1. **Real-time PLC Communication**
   - libplctag runs natively with direct network access
   - No container networking overhead
   - Ethernet/IP works reliably

2. **Field Deployment**
   - Electricians double-click one file
   - No Docker installation required
   - Works on any Windows laptop

3. **Performance**
   - Faster startup (critical for job sites)
   - Lower memory usage
   - No virtualization overhead

4. **Debugging**
   - Can attach debugger directly
   - Native Windows event logs
   - Easy to check processes

### When Docker Makes Sense (NOT this project)

- Cloud deployments with scaling requirements
- Multi-environment CI/CD pipelines
- Microservices with complex dependencies
- Linux server deployments

## Directory Structure

```
deploy/
├── BUILD-DISTRIBUTION.ps1   # Main build script
├── BUILD.bat                 # Quick launcher for build script
├── DEV-START.bat            # Start development servers
├── DEV-STOP.bat             # Stop development servers
├── DEPLOYMENT-GUIDE.md      # This file
└── IO-Checkout-Distribution/ # Output folder (after build)
    ├── backend/             # Self-contained .NET 9 app
    ├── frontend/            # Next.js standalone build
    ├── nodejs/              # Portable Node.js
    ├── START.bat            # Launch application
    ├── STOP.bat             # Stop application
    ├── STATUS.bat           # Check status & show IP
    ├── ALLOW-FIREWALL.bat   # Configure Windows Firewall
    └── README.txt           # User instructions
```

## Build Instructions

### Prerequisites (Development Machine)

1. **.NET 9 SDK** - https://dotnet.microsoft.com/download
2. **Node.js 20+** - https://nodejs.org
3. **PowerShell 5.1+** (included in Windows 10/11)

### Building the Distribution

```powershell
cd local-tool\deploy
.\BUILD-DISTRIBUTION.ps1
```

Or double-click `BUILD.bat`

### Build Options

```powershell
# Skip downloading Node.js (if already have it)
.\BUILD-DISTRIBUTION.ps1 -SkipNodeDownload

# Skip backend build (if already built)
.\BUILD-DISTRIBUTION.ps1 -SkipBackendBuild

# Skip frontend build (if already built)
.\BUILD-DISTRIBUTION.ps1 -SkipFrontendBuild
```

## Deployment Instructions

### Target Machine Requirements

- Windows 10/11 (64-bit)
- No additional software needed (all bundled)
- Network access to PLC
- WiFi for multi-device access

### Deployment Steps

1. **Copy** `IO-Checkout-Distribution` folder to target laptop
2. **Configure** PLC settings in `backend\config.json`:
   ```json
   {
     "ip": "192.168.1.100",      // PLC IP address
     "path": "1,0",              // Ethernet/IP path
     "subsystemId": "16"         // Subsystem to test
   }
   ```
3. **Run** `ALLOW-FIREWALL.bat` as Administrator (if network access needed)
4. **Double-click** `START.bat`
5. **Share** the network URL with electricians

### Network Access Setup

When START.bat runs, it displays:
```
LOCAL ACCESS:
  http://localhost:3000

NETWORK ACCESS (phones/tablets):
  http://192.168.1.100:3000
```

All devices on the same WiFi can access the second URL.

### Firewall Configuration

If phones/tablets can't connect, run `ALLOW-FIREWALL.bat` as Administrator.

Manual commands:
```cmd
netsh advfirewall firewall add rule name="IO Checkout 3000" dir=in action=allow protocol=TCP localport=3000
netsh advfirewall firewall add rule name="IO Checkout 5000" dir=in action=allow protocol=TCP localport=5000
```

## Troubleshooting

### Backend won't start
- Check `config.json` has valid PLC IP
- Ensure port 5000 is not used by another app
- Check Windows Event Viewer for errors

### Frontend won't start
- Verify `nodejs\node.exe` exists OR Node.js is installed
- Ensure port 3000 is not used
- Check for JavaScript errors in browser console

### Phones can't connect
- Verify all devices are on same WiFi network
- Run `STATUS.bat` to confirm correct IP
- Run `ALLOW-FIREWALL.bat` as Administrator
- Try disabling Windows Firewall temporarily to test

### PLC connection fails
- Ping the PLC from laptop: `ping 192.168.x.x`
- Verify Ethernet/IP path in config.json
- Check PLC is in Run mode
- Verify laptop is on same subnet as PLC

### SignalR disconnects
- Check WiFi stability
- SignalR auto-reconnects with exponential backoff
- Status indicator shows connection state

## Development Workflow

### Start Development Servers

```cmd
cd local-tool\deploy
DEV-START.bat
```

This starts:
- Backend with hot-reload: `dotnet run`
- Frontend with hot-reload: `npm run dev`

### Stop Development Servers

```cmd
DEV-STOP.bat
```

Or press Ctrl+C in each terminal window.

## Production Checklist

Before deploying to field:

- [ ] Test PLC connection with actual hardware
- [ ] Verify config.json has correct PLC IP and path
- [ ] Test multi-device access from phones/tablets
- [ ] Run ALLOW-FIREWALL.bat on target laptop
- [ ] Test all IO pass/fail/clear functions
- [ ] Verify SignalR updates across all devices
- [ ] Create backup of config.json with site settings
