# =============================================================================
# IO Checkout Tool - Production Build Script
# Creates a self-contained Windows distribution for field deployment
# =============================================================================

param(
    [switch]$SkipNodeDownload,
    [switch]$SkipBackendBuild,
    [switch]$SkipFrontendBuild
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  ╔═══════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║       IO CHECKOUT TOOL - PRODUCTION BUILD                     ║" -ForegroundColor Cyan
Write-Host "  ║       For Windows Field Deployment                            ║" -ForegroundColor Cyan
Write-Host "  ╚═══════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Configuration
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir
$outputDir = Join-Path $scriptDir "IO-Checkout-Distribution"
$backendSource = Join-Path $rootDir "IO-Checkout-Tool copy"
$frontendSource = Join-Path $rootDir "commissioning-tool-frontend"
$nodeVersion = "20.11.0"

# Verify source directories exist
if (-not (Test-Path $backendSource)) {
    Write-Host "ERROR: Backend source not found at: $backendSource" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $frontendSource)) {
    Write-Host "ERROR: Frontend source not found at: $frontendSource" -ForegroundColor Red
    exit 1
}

# Stop any running instances
Write-Host "[PREP] Stopping any running instances..." -ForegroundColor Yellow
Get-Process -Name "IO Checkout Tool" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# Clean and create output directory
Write-Host "[PREP] Preparing output directory..." -ForegroundColor Yellow
if (Test-Path $outputDir) {
    Remove-Item $outputDir -Recurse -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
New-Item -ItemType Directory -Path "$outputDir\backend" -Force | Out-Null
New-Item -ItemType Directory -Path "$outputDir\frontend" -Force | Out-Null
New-Item -ItemType Directory -Path "$outputDir\nodejs" -Force | Out-Null

# =============================================================================
# STEP 1: Build .NET Backend
# =============================================================================
if (-not $SkipBackendBuild) {
    Write-Host ""
    Write-Host "[1/4] Building C# Backend (self-contained .NET 9)..." -ForegroundColor Cyan
    Write-Host "      Source: $backendSource" -ForegroundColor Gray

    Push-Location $backendSource
    try {
        # Build self-contained for Windows x64
        dotnet publish -c Release -r win-x64 --self-contained true `
            -p:PublishSingleFile=false `
            -p:IncludeNativeLibrariesForSelfExtract=true `
            -o "$outputDir\backend" 2>&1 | ForEach-Object {
                if ($_ -match "error") { Write-Host $_ -ForegroundColor Red }
                elseif ($_ -match "warning") { Write-Host $_ -ForegroundColor Yellow }
            }

        if ($LASTEXITCODE -ne 0) {
            throw "Backend build failed"
        }

        # Remove config.json so app creates fresh one on first run (triggers setup wizard)
        $configPath = "$outputDir\backend\config.json"
        if (Test-Path $configPath) {
            Remove-Item $configPath -Force
            Write-Host "      Removed config.json (will be created on first run)" -ForegroundColor Gray
        }

        Write-Host "      Backend built successfully!" -ForegroundColor Green
    }
    finally {
        Pop-Location
    }
} else {
    Write-Host "[1/4] Skipping backend build (--SkipBackendBuild)" -ForegroundColor Gray
}

# =============================================================================
# STEP 2: Build Next.js Frontend
# =============================================================================
if (-not $SkipFrontendBuild) {
    Write-Host ""
    Write-Host "[2/4] Building Next.js Frontend..." -ForegroundColor Cyan
    Write-Host "      Source: $frontendSource" -ForegroundColor Gray

    Push-Location $frontendSource
    try {
        # Install dependencies if needed
        if (-not (Test-Path "node_modules")) {
            Write-Host "      Installing dependencies..." -ForegroundColor Gray
            npm ci 2>&1 | Out-Null
        }

        # Build production
        npm run build 2>&1 | ForEach-Object {
            if ($_ -match "error" -and $_ -notmatch "prerender") {
                Write-Host $_ -ForegroundColor Red
            }
        }

        # Copy standalone build
        if (Test-Path ".next\standalone") {
            Write-Host "      Copying standalone build..." -ForegroundColor Gray
            Copy-Item -Path ".next\standalone\*" -Destination "$outputDir\frontend" -Recurse -Force

            # Copy static assets (required)
            if (Test-Path ".next\static") {
                New-Item -ItemType Directory -Path "$outputDir\frontend\.next\static" -Force | Out-Null
                Copy-Item -Path ".next\static\*" -Destination "$outputDir\frontend\.next\static" -Recurse -Force
            }

            # Copy public folder
            if (Test-Path "public") {
                Copy-Item -Path "public" -Destination "$outputDir\frontend\public" -Recurse -Force -ErrorAction SilentlyContinue
            }

            Write-Host "      Frontend built successfully!" -ForegroundColor Green
        } else {
            throw "Standalone build not found - check next.config.js has output: 'standalone'"
        }
    }
    finally {
        Pop-Location
    }
} else {
    Write-Host "[2/4] Skipping frontend build (--SkipFrontendBuild)" -ForegroundColor Gray
}

# =============================================================================
# STEP 3: Download Node.js Portable
# =============================================================================
if (-not $SkipNodeDownload) {
    Write-Host ""
    Write-Host "[3/4] Getting Node.js portable runtime..." -ForegroundColor Cyan

    $nodeUrl = "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip"
    $nodeZip = Join-Path $env:TEMP "node-portable.zip"
    $nodeExtract = Join-Path $env:TEMP "node-extract"

    try {
        Write-Host "      Downloading Node.js v$nodeVersion..." -ForegroundColor Gray
        Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip -UseBasicParsing

        Write-Host "      Extracting..." -ForegroundColor Gray
        if (Test-Path $nodeExtract) { Remove-Item $nodeExtract -Recurse -Force }
        Expand-Archive -Path $nodeZip -DestinationPath $nodeExtract -Force

        # Find and copy node.exe
        $nodeFolder = Get-ChildItem $nodeExtract -Directory | Select-Object -First 1
        Copy-Item -Path "$($nodeFolder.FullName)\node.exe" -Destination "$outputDir\nodejs\node.exe" -Force

        # Cleanup
        Remove-Item $nodeZip -Force -ErrorAction SilentlyContinue
        Remove-Item $nodeExtract -Recurse -Force -ErrorAction SilentlyContinue

        Write-Host "      Node.js portable included!" -ForegroundColor Green
    }
    catch {
        Write-Host "      WARNING: Could not download Node.js automatically" -ForegroundColor Yellow
        Write-Host "      Workers will need Node.js installed on their system" -ForegroundColor Yellow
    }
} else {
    Write-Host "[3/4] Skipping Node.js download (--SkipNodeDownload)" -ForegroundColor Gray
}

# =============================================================================
# STEP 4: Create Launcher Scripts
# =============================================================================
Write-Host ""
Write-Host "[4/4] Creating launcher scripts..." -ForegroundColor Cyan

# START.bat - Main launcher with network info
@"
@echo off
chcp 65001 >nul
title IO Checkout Tool
color 0A

echo.
echo  ╔═══════════════════════════════════════════════════════════════╗
echo  ║           IO CHECKOUT TOOL - Starting...                      ║
echo  ╚═══════════════════════════════════════════════════════════════╝
echo.

set SCRIPT_DIR=%~dp0

:: Get local IP address for network access
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    for /f "tokens=1" %%b in ("%%a") do set LOCAL_IP=%%b
)

:: Check if backend already running
tasklist /FI "IMAGENAME eq IO Checkout Tool.exe" 2>NUL | find /I "IO Checkout Tool.exe" >NUL
if "%ERRORLEVEL%"=="0" (
    echo  [!] Backend already running
    goto :start_frontend
)

:: Start Backend
echo  [1/3] Starting C# Backend on port 5000...
cd /d "%SCRIPT_DIR%backend"
start /MIN "IO-Backend" "IO Checkout Tool.exe"
timeout /t 3 /nobreak >nul

:: Wait for backend to be ready
echo  [2/3] Waiting for backend...
:wait_backend
timeout /t 1 /nobreak >nul
netstat -an | find ":5000" | find "LISTENING" >nul
if errorlevel 1 goto :wait_backend
echo        Backend ready!

:start_frontend
:: Find Node.js
set NODE_EXE=%SCRIPT_DIR%nodejs\node.exe
if not exist "%NODE_EXE%" (
    where node >nul 2>&1
    if errorlevel 1 (
        echo.
        echo  [ERROR] Node.js not found!
        echo  Please install Node.js from https://nodejs.org
        pause
        exit /b 1
    )
    set NODE_EXE=node
)

:: Start Frontend
echo  [3/3] Starting Next.js Frontend on port 3000...
cd /d "%SCRIPT_DIR%frontend"
start /MIN "IO-Frontend" "%NODE_EXE%" server.js
timeout /t 2 /nobreak >nul

:: Display access information
echo.
echo  ╔═══════════════════════════════════════════════════════════════╗
echo  ║                    APPLICATION READY                          ║
echo  ╠═══════════════════════════════════════════════════════════════╣
echo  ║                                                               ║
echo  ║  LOCAL ACCESS:                                                ║
echo  ║    http://localhost:3000                                      ║
echo  ║                                                               ║
echo  ║  NETWORK ACCESS (phones/tablets):                             ║
echo  ║    http://%LOCAL_IP%:3000                                     ║
echo  ║                                                               ║
echo  ║  Share this address with electricians!                        ║
echo  ║                                                               ║
echo  ╚═══════════════════════════════════════════════════════════════╝
echo.

:: Open browser
timeout /t 2 /nobreak >nul
start http://localhost:3000

echo  Press any key to hide this window (app keeps running)...
pause >nul
"@ | Out-File -FilePath "$outputDir\START.bat" -Encoding ASCII

# STOP.bat - Stop all services
@"
@echo off
chcp 65001 >nul
title IO Checkout Tool - Stopping
color 0C

echo.
echo  Stopping IO Checkout Tool...
echo.

taskkill /F /IM "IO Checkout Tool.exe" 2>nul
taskkill /F /FI "WINDOWTITLE eq IO-Backend*" 2>nul
taskkill /F /FI "WINDOWTITLE eq IO-Frontend*" 2>nul

echo.
echo  ╔═══════════════════════════════════════════════════════════════╗
echo  ║              APPLICATION STOPPED                              ║
echo  ╚═══════════════════════════════════════════════════════════════╝
echo.
pause
"@ | Out-File -FilePath "$outputDir\STOP.bat" -Encoding ASCII

# STATUS.bat - Check if running and show IP
@"
@echo off
chcp 65001 >nul
title IO Checkout Tool - Status

:: Get local IP
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    for /f "tokens=1" %%b in ("%%a") do set LOCAL_IP=%%b
)

echo.
echo  ╔═══════════════════════════════════════════════════════════════╗
echo  ║              IO CHECKOUT TOOL - STATUS                        ║
echo  ╚═══════════════════════════════════════════════════════════════╝
echo.

:: Check backend
tasklist /FI "IMAGENAME eq IO Checkout Tool.exe" 2>NUL | find /I "IO Checkout Tool.exe" >NUL
if "%ERRORLEVEL%"=="0" (
    echo  [✓] Backend:  RUNNING on port 5000
) else (
    echo  [✗] Backend:  NOT RUNNING
)

:: Check frontend
netstat -an | find ":3000" | find "LISTENING" >nul
if "%ERRORLEVEL%"=="0" (
    echo  [✓] Frontend: RUNNING on port 3000
) else (
    echo  [✗] Frontend: NOT RUNNING
)

echo.
echo  ═══════════════════════════════════════════════════════════════
echo.
echo  NETWORK ACCESS URL (share with team):
echo.
echo      http://%LOCAL_IP%:3000
echo.
echo  ═══════════════════════════════════════════════════════════════
echo.
pause
"@ | Out-File -FilePath "$outputDir\STATUS.bat" -Encoding ASCII

# README.txt
@"
================================================================================
                    IO CHECKOUT TOOL - FIELD DEPLOYMENT
================================================================================

QUICK START
-----------
1. Double-click START.bat
2. Wait for both services to start (about 10 seconds)
3. Browser opens automatically
4. Share the NETWORK URL with your team

NETWORK ACCESS
--------------
When the app starts, it shows two URLs:
- LOCAL:   http://localhost:3000     (for this computer)
- NETWORK: http://192.168.x.x:3000   (for phones/tablets)

All devices on the same WiFi network can connect using the NETWORK URL.
Real-time updates sync across ALL connected devices automatically!

COMMANDS
--------
START.bat   - Start the application
STOP.bat    - Stop the application
STATUS.bat  - Check if running and show network URL

FIREWALL
--------
If other devices can't connect, you may need to allow ports in Windows Firewall:
- Port 3000 (Frontend)
- Port 5000 (Backend)

Run this in PowerShell as Administrator:
  netsh advfirewall firewall add rule name="IO Checkout 3000" dir=in action=allow protocol=TCP localport=3000
  netsh advfirewall firewall add rule name="IO Checkout 5000" dir=in action=allow protocol=TCP localport=5000

CONFIGURATION
-------------
PLC settings are in: backend\config.json
- ip: PLC IP address
- path: Ethernet/IP path
- subsystemId: Which subsystem to test

TROUBLESHOOTING
---------------
1. Backend won't start:
   - Check config.json has correct PLC IP
   - Make sure port 5000 is not in use

2. Frontend won't start:
   - Make sure Node.js is installed or nodejs\node.exe exists
   - Make sure port 3000 is not in use

3. Phones can't connect:
   - All devices must be on same WiFi network
   - Check Windows Firewall (see FIREWALL section)
   - Try STATUS.bat to see the correct IP

4. PLC connection fails:
   - Verify PLC IP in config.json
   - Make sure laptop is on same network as PLC
   - Check Ethernet/IP path matches your PLC setup

================================================================================
"@ | Out-File -FilePath "$outputDir\README.txt" -Encoding ASCII

# ALLOW-FIREWALL.bat - Run as admin to allow firewall
@"
@echo off
:: This script must be run as Administrator
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Please run this script as Administrator!
    echo Right-click and select "Run as administrator"
    pause
    exit /b 1
)

echo Adding firewall rules for IO Checkout Tool...
netsh advfirewall firewall add rule name="IO Checkout Frontend (3000)" dir=in action=allow protocol=TCP localport=3000
netsh advfirewall firewall add rule name="IO Checkout Backend (5000)" dir=in action=allow protocol=TCP localport=5000
echo.
echo Firewall rules added successfully!
echo Other devices on the network can now connect.
pause
"@ | Out-File -FilePath "$outputDir\ALLOW-FIREWALL.bat" -Encoding ASCII

Write-Host "      Launcher scripts created!" -ForegroundColor Green

# =============================================================================
# DONE
# =============================================================================
Write-Host ""
Write-Host "  ╔═══════════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "  ║              BUILD COMPLETE!                                  ║" -ForegroundColor Green
Write-Host "  ╚═══════════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  Output: $outputDir" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Contents:" -ForegroundColor White
Write-Host "    backend\     - C# .NET 9 self-contained application" -ForegroundColor Gray
Write-Host "    frontend\    - Next.js standalone build" -ForegroundColor Gray
Write-Host "    nodejs\      - Portable Node.js runtime" -ForegroundColor Gray
Write-Host "    START.bat    - Launch application" -ForegroundColor Gray
Write-Host "    STOP.bat     - Stop application" -ForegroundColor Gray
Write-Host "    STATUS.bat   - Check status & show network URL" -ForegroundColor Gray
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor Yellow
Write-Host "    1. Test START.bat on this machine" -ForegroundColor White
Write-Host "    2. Copy folder to target laptop" -ForegroundColor White
Write-Host "    3. Run ALLOW-FIREWALL.bat as admin (if network access needed)" -ForegroundColor White
Write-Host "    4. Double-click START.bat to run" -ForegroundColor White
Write-Host ""
