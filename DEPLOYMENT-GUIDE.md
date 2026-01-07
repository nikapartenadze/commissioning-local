# IO Checkout Tool - Deployment Guide

## Overview

This guide explains how to build and deploy the IO Checkout Tool as a portable distribution that can be easily deployed to customer sites without requiring installation.

---

## Prerequisites

### On Your Development Machine:

1. **Node.js 18+** - For building the frontend
   - Download from: https://nodejs.org/
   - Verify: `node --version`

2. **.NET 9.0 SDK** - For building the backend
   - Download from: https://dotnet.microsoft.com/download
   - Verify: `dotnet --version`

3. **PowerShell** - For running the build script (included in Windows)

---

## Building the Portable Distribution

### Quick Build (Recommended)

1. **Open PowerShell** in the project root directory
2. **Run the build script:**
   ```powershell
   .\REBUILD-DISTRIBUTION.bat
   ```
   
   This will:
   - Build the C# backend (self-contained)
   - Build the Next.js frontend (standalone mode)
   - Download portable Node.js runtime
   - Create the `IO-Checkout-Tool-Portable` folder

3. **Wait for completion** (5-10 minutes depending on internet speed)

### Manual Build Steps

If the automated script fails, you can build manually:

#### Step 1: Build Backend

```powershell
cd backend
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=false -o "..\IO-Checkout-Tool-Portable\backend"
cd ..
```

#### Step 2: Build Frontend

```powershell
cd frontend
npm install
npm run build
```

After build completes, copy the standalone output:

```powershell
# Copy standalone server files
Copy-Item -Path ".next\standalone\*" -Destination "..\IO-Checkout-Tool-Portable\frontend" -Recurse -Force

# Copy static assets
New-Item -ItemType Directory -Path "..\IO-Checkout-Tool-Portable\frontend\.next\static" -Force
Copy-Item -Path ".next\static\*" -Destination "..\IO-Checkout-Tool-Portable\frontend\.next\static" -Recurse -Force

# Copy public assets
Copy-Item -Path "public" -Destination "..\IO-Checkout-Tool-Portable\frontend\public" -Recurse -Force -ErrorAction SilentlyContinue

cd ..
```

#### Step 3: Download Portable Node.js

1. Download Node.js Windows x64 ZIP from: https://nodejs.org/dist/v20.11.0/node-v20.11.0-win-x64.zip
2. Extract the ZIP file
3. Copy `node.exe` to `IO-Checkout-Tool-Portable\nodejs\node.exe`

---

## Deploying to Customer Site

### What to Deliver

Package and deliver the entire `IO-Checkout-Tool-Portable` folder to the customer. This folder contains:

```
IO-Checkout-Tool-Portable/
├── backend/              # C# .NET application (self-contained)
├── frontend/             # Next.js application (built)
├── nodejs/               # Portable Node.js runtime
├── START.bat             # Launch script
├── STOP.bat              # Shutdown script
└── README.txt            # Quick start guide
```

### Delivery Methods

**Option 1: ZIP File**
```powershell
# Create a ZIP file for easy transfer
Compress-Archive -Path "IO-Checkout-Tool-Portable" -DestinationPath "IO-Checkout-Tool-Portable.zip"
```

**Option 2: USB Drive**
- Copy the entire folder to a USB drive
- Customer can copy to their server

**Option 3: Network Share**
- Copy to a shared network location
- Customer downloads from internal network

---

## Installation at Customer Site

### Requirements on Customer Server:

- **Windows 10/11 or Windows Server 2016+**
- **No additional software needed!** (Everything is included)
- **Network access** to PLC (if using PLC features)
- **Internet access** (optional, only for cloud sync)

### Installation Steps:

1. **Copy the folder** to the server (e.g., `C:\IO-Checkout-Tool\`)

2. **Configure PLC connection** (if using PLC):
   - Open `backend\config.json` in Notepad
   - Set the PLC IP address and path:
     ```json
     {
       "ip": "192.168.1.100",
       "path": "1,0",
       "subsystemId": "1",
       "remoteUrl": "",
       "orderMode": "0"
     }
     ```

3. **Configure Windows Firewall** (if accessing from other computers):
   - Allow inbound connections on port **3000** (Frontend)
   - Allow inbound connections on port **5000** (Backend)
   
   **PowerShell commands** (run as Administrator):
   ```powershell
   New-NetFirewallRule -DisplayName "IO Checkout Frontend" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
   New-NetFirewallRule -DisplayName "IO Checkout Backend" -Direction Inbound -LocalPort 5000 -Protocol TCP -Action Allow
   ```

4. **Start the application**:
   - Double-click `START.bat`
   - Wait for both servers to start
   - Browser will open automatically

5. **Access from other computers**:
   - Find server IP address: `ipconfig` in Command Prompt
   - Open browser on any computer: `http://SERVER_IP:3000`
   - Example: `http://192.168.1.50:3000`

---

## Starting and Stopping

### Start Application

**Method 1: Double-click START.bat**
- Opens command window
- Starts backend and frontend
- Opens browser automatically
- Command window can be closed (apps keep running)

**Method 2: Run as Windows Service** (Advanced)
- Use NSSM (Non-Sucking Service Manager) to install as service
- Application starts automatically on server boot
- See: https://nssm.cc/

### Stop Application

**Method 1: Double-click STOP.bat**
- Gracefully stops both backend and frontend

**Method 2: Task Manager**
- Find "IO Checkout Tool.exe" and "node.exe"
- End tasks

---

## Configuration

### PLC Configuration

Edit `backend\config.json`:

```json
{
  "ip": "192.168.1.100",        // PLC IP address
  "path": "1,0",                 // PLC communication path (slot,port)
  "subsystemId": "1",            // Unique subsystem identifier
  "remoteUrl": "",               // Cloud sync URL (optional)
  "ApiPassword": "",             // Cloud API password (optional)
  "orderMode": "0",              // 0=any order, 1=sequential
  "disableWatchdog": false       // Watchdog feature
}
```

**How to get PLC configuration:**
- **IP Address**: Ask network administrator or check PLC Ethernet module
- **Path**: Ask PLC programmer (usually `1,0` or `0,0`)
- **SubsystemId**: Choose unique number for each subsystem (1, 2, 3, etc.)

### Cloud Sync Configuration (Optional)

If using cloud sync for remote monitoring:

1. **Set remoteUrl** to your cloud server:
   ```json
   {
     "remoteUrl": "https://your-cloud-server.com",
     "ApiPassword": "your-api-key"
   }
   ```

2. **Cloud server must have these endpoints:**
   - `GET /api/sync/health` - Health check
   - `GET /api/sync/subsystem/{id}` - Get IO definitions
   - `POST /api/sync/update` - Upload test results

---

## Troubleshooting

### Backend Won't Start

**Error: "IO Checkout Tool.exe not found"**
- Solution: Rebuild the distribution, backend didn't compile correctly

**Error: Port 5000 already in use**
- Solution: Stop other applications using port 5000, or change port in backend configuration

**Error: Database access denied**
- Solution: Check file permissions on `backend\database.db`

### Frontend Won't Start

**Error: "Node.js not found"**
- Solution: Ensure `nodejs\node.exe` exists in the portable folder
- Alternative: Install Node.js on the server

**Error: "server.js not found"**
- Solution: Frontend wasn't built correctly, rebuild the distribution

**Error: Port 3000 already in use**
- Solution: Stop other applications using port 3000

### PLC Connection Issues

**Error: "PLC not connected"**
- Check PLC IP address is correct
- Verify network connectivity: `ping 192.168.1.100`
- Ensure PLC path is correct (ask PLC programmer)
- Check firewall isn't blocking communication

### Network Access Issues

**Can't access from other computers**
- Check Windows Firewall rules (ports 3000 and 5000)
- Verify server IP address
- Ensure all computers are on same network
- Try accessing from server first: `http://localhost:3000`

---

## Updating the Application

### To Deploy Updates:

1. **Build new distribution** on development machine
2. **Stop the application** on customer server (STOP.bat)
3. **Backup the database**:
   ```powershell
   Copy-Item "backend\database.db" "backend\database.db.backup"
   ```
4. **Replace the files**:
   - Delete old `backend` and `frontend` folders
   - Copy new `backend` and `frontend` folders
   - Keep `database.db` from backup
5. **Restart the application** (START.bat)

### Preserving User Data

**Important files to preserve:**
- `backend\database.db` - Contains all test results and user accounts
- `backend\config.json` - Contains PLC configuration

**Safe to replace:**
- All `.exe`, `.dll`, `.js` files
- Everything in `frontend` folder
- `nodejs` folder

---

## Performance Optimization

### For Large Projects (1000+ I/O Points)

1. **Increase server resources:**
   - Minimum: 4GB RAM, 2 CPU cores
   - Recommended: 8GB RAM, 4 CPU cores

2. **Database optimization:**
   - Regularly export and archive old test data
   - Keep active database under 100MB

3. **Network optimization:**
   - Use wired Ethernet for server
   - Ensure good WiFi coverage for tablets
   - Consider dedicated network for PLC communication

### For Multiple Concurrent Users (10+ Users)

1. **Use dedicated server** (not a shared workstation)
2. **Monitor resources** with Task Manager
3. **Organize testing** by subsystem to reduce conflicts
4. **Use filters** to reduce data loaded per user

---

## Security Considerations

### User Access Control

- Default admin PIN: `852963` (change immediately!)
- Create individual PINs for each electrician
- Deactivate users when they leave project

### Network Security

- Keep server on internal network (not exposed to internet)
- Use VPN for remote access if needed
- Regularly backup database to secure location

### Data Backup

**Recommended backup schedule:**
- **Daily**: Automatic backup of `database.db`
- **Weekly**: Export test results to CSV
- **Monthly**: Full folder backup

**Backup script example:**
```powershell
# backup-database.ps1
$date = Get-Date -Format "yyyy-MM-dd"
Copy-Item "backend\database.db" "backups\database-$date.db"
```

---

## Support and Maintenance

### Log Files

- **Backend logs**: Check Command Prompt window when running without `/MIN`
- **Frontend logs**: Check browser Developer Console (F12)

### Common Maintenance Tasks

**Weekly:**
- Check disk space
- Review error logs
- Test PLC connectivity

**Monthly:**
- Backup database
- Export test results
- Update user accounts

**Quarterly:**
- Review and archive old projects
- Update application if new version available
- Test disaster recovery procedure

---

## Appendix: File Structure

### Backend Files (Important)

```
backend/
├── IO Checkout Tool.exe        # Main application
├── database.db                 # SQLite database (CRITICAL - backup regularly!)
├── config.json                 # PLC configuration (CRITICAL - backup before updates)
├── appsettings.json           # Application settings
└── [many .dll files]          # Dependencies (replace during updates)
```

### Frontend Files (Important)

```
frontend/
├── server.js                   # Next.js server entry point
├── .next/                     # Built application
│   ├── standalone/            # Standalone server files
│   └── static/                # Static assets (CSS, JS)
└── public/                    # Public assets (images, fonts)
```

---

## Quick Reference

### Common Commands

```powershell
# Start application
.\START.bat

# Stop application
.\STOP.bat

# Rebuild distribution
.\REBUILD-DISTRIBUTION.bat

# Check if backend is running
tasklist | findstr "IO Checkout Tool.exe"

# Check if frontend is running
tasklist | findstr "node.exe"

# Check ports in use
netstat -an | findstr ":3000"
netstat -an | findstr ":5000"

# Backup database
Copy-Item "backend\database.db" "database-backup.db"
```

### Default Settings

- **Frontend URL**: http://localhost:3000
- **Backend URL**: http://localhost:5000
- **Admin PIN**: 852963
- **Frontend Port**: 3000
- **Backend Port**: 5000

### Support Contacts

- **Technical Issues**: [Your support email]
- **PLC Configuration**: [PLC programmer contact]
- **Network Issues**: [IT department contact]

---

**Document Version**: 1.0  
**Last Updated**: January 2026  
**Application**: IO Checkout Tool - Portable Distribution

