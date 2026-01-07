# PowerShell script to create portable distribution
# Run this script to package the application for factory workers

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  IO Checkout Tool - Distribution Builder" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$distributionFolder = "IO-Checkout-Tool-Portable"
$backendSource = "backend"
$frontendSource = "frontend"

# Step 1: Create distribution folder
Write-Host "[1/5] Creating distribution folder..." -ForegroundColor Yellow

# Stop running processes first to release file locks
Write-Host "Stopping any running instances..." -ForegroundColor Cyan
Get-Process -Name "IO Checkout Tool" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*IO-Checkout*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# Try to remove old distribution, but continue even if it fails (files might be locked)
if (Test-Path $distributionFolder) {
    Write-Host "Removing old distribution folder..." -ForegroundColor Cyan
    try {
        Remove-Item $distributionFolder -Recurse -Force -ErrorAction Stop
        Write-Host "Old distribution removed successfully." -ForegroundColor Green
    } catch {
        Write-Host "Warning: Could not fully remove old distribution (some files may be locked). Continuing anyway..." -ForegroundColor Yellow
        Write-Host "If build fails, please stop the application and try again." -ForegroundColor Yellow
    }
}

# Create directories (will succeed even if they already exist)
New-Item -ItemType Directory -Path $distributionFolder -Force | Out-Null
New-Item -ItemType Directory -Path "$distributionFolder\backend" -Force | Out-Null
New-Item -ItemType Directory -Path "$distributionFolder\frontend" -Force | Out-Null
New-Item -ItemType Directory -Path "$distributionFolder\nodejs" -Force | Out-Null

# Step 2: Build .NET backend (self-contained)
Write-Host "[2/5] Building .NET backend (self-contained)..." -ForegroundColor Yellow
Push-Location $backendSource
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=false -o "..\$distributionFolder\backend"
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to build backend!" -ForegroundColor Red
    Pop-Location
    exit 1
}
Pop-Location

# Step 3: Build Next.js frontend
Write-Host "[3/5] Building Next.js frontend..." -ForegroundColor Yellow
Push-Location $frontendSource
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to build frontend!" -ForegroundColor Red
    Pop-Location
    exit 1
}

# Copy standalone build
if (Test-Path ".next\standalone") {
    # Copy standalone server files
    Copy-Item -Path ".next\standalone\*" -Destination "..\$distributionFolder\frontend" -Recurse -Force
    
    # Copy static assets (required for standalone mode)
    if (Test-Path ".next\static") {
        Write-Host "Copying static assets..." -ForegroundColor Cyan
        New-Item -ItemType Directory -Path "..\$distributionFolder\frontend\.next\static" -Force | Out-Null
        Copy-Item -Path ".next\static\*" -Destination "..\$distributionFolder\frontend\.next\static" -Recurse -Force
    }
    
    # Copy public folder if it exists
    if (Test-Path "public") {
        Write-Host "Copying public assets..." -ForegroundColor Cyan
        Copy-Item -Path "public" -Destination "..\$distributionFolder\frontend\public" -Recurse -Force -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "WARNING: Standalone build not found. Copying entire .next folder..." -ForegroundColor Yellow
    Copy-Item -Path ".next" -Destination "..\$distributionFolder\frontend\.next" -Recurse -Force
    Copy-Item -Path "public" -Destination "..\$distributionFolder\frontend\public" -Recurse -Force -ErrorAction SilentlyContinue
}
Pop-Location

# Step 4: Download and extract Node.js portable
Write-Host "[4/5] Downloading Node.js portable (this may take a few minutes)..." -ForegroundColor Yellow

$nodejsVersion = "20.11.0"  # LTS version
$nodejsUrl = "https://nodejs.org/dist/v$nodejsVersion/node-v$nodejsVersion-win-x64.zip"
$nodejsZip = "$env:TEMP\nodejs-portable.zip"
$nodejsExtract = "$env:TEMP\nodejs-extract"

# Check if already downloaded
if (-not (Test-Path $nodejsZip)) {
    Write-Host "Downloading Node.js from nodejs.org..." -ForegroundColor Cyan
    try {
        Invoke-WebRequest -Uri $nodejsUrl -OutFile $nodejsZip -UseBasicParsing
        Write-Host "Download complete." -ForegroundColor Green
    } catch {
        Write-Host "ERROR: Failed to download Node.js automatically." -ForegroundColor Red
        Write-Host "Please manually download Node.js Windows x64 ZIP from:" -ForegroundColor Yellow
        Write-Host "https://nodejs.org/dist/v$nodejsVersion/node-v$nodejsVersion-win-x64.zip" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "Then extract it and provide the path:" -ForegroundColor Yellow
        $nodejsPath = Read-Host "Enter path to extracted Node.js folder (e.g., C:\node-v20.11.0-win-x64)"
        
        if ($nodejsPath -and (Test-Path $nodejsPath)) {
            Copy-Item -Path "$nodejsPath\*" -Destination "$distributionFolder\nodejs" -Recurse -Force
            Write-Host "Node.js copied successfully." -ForegroundColor Green
        } else {
            Write-Host "ERROR: Invalid path provided. Node.js will not be included." -ForegroundColor Red
            Write-Host "Workers will need Node.js installed or you can add it manually later." -ForegroundColor Yellow
        }
    }
}

# Extract if download succeeded
if (Test-Path $nodejsZip) {
    Write-Host "Extracting Node.js..." -ForegroundColor Cyan
    if (Test-Path $nodejsExtract) {
        Remove-Item $nodejsExtract -Recurse -Force
    }
    Expand-Archive -Path $nodejsZip -DestinationPath $nodejsExtract -Force
    
    # Find the extracted folder
    $extractedFolder = Get-ChildItem $nodejsExtract -Directory | Where-Object { $_.Name -like "node-v*-win-x64" } | Select-Object -First 1
    
    if ($extractedFolder) {
        # Copy only necessary files (node.exe and required DLLs)
        Write-Host "Copying Node.js runtime files..." -ForegroundColor Cyan
        Copy-Item -Path "$($extractedFolder.FullName)\node.exe" -Destination "$distributionFolder\nodejs\node.exe" -Force
        Copy-Item -Path "$($extractedFolder.FullName)\*.dll" -Destination "$distributionFolder\nodejs\" -Force -ErrorAction SilentlyContinue
        
        # Copy npm if needed (optional, but useful)
        if (Test-Path "$($extractedFolder.FullName)\npm.cmd") {
            New-Item -ItemType Directory -Path "$distributionFolder\nodejs\node_modules\npm" -Force | Out-Null
            Copy-Item -Path "$($extractedFolder.FullName)\npm*" -Destination "$distributionFolder\nodejs\" -Recurse -Force -ErrorAction SilentlyContinue
        }
        
        Write-Host "Node.js portable included successfully!" -ForegroundColor Green
        
        # Cleanup
        Remove-Item $nodejsZip -Force -ErrorAction SilentlyContinue
        Remove-Item $nodejsExtract -Recurse -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host "WARNING: Could not find extracted Node.js folder." -ForegroundColor Yellow
    }
}

# Step 5: Create launcher scripts
Write-Host "[5/5] Creating launcher scripts..." -ForegroundColor Yellow

# START.bat
$startBat = @"
@echo off
title IO Checkout Tool Launcher
color 0A

echo ========================================
echo   IO Checkout Tool - Starting...
echo ========================================
echo.

REM Get script directory
set SCRIPT_DIR=%~dp0

REM Check if backend is already running
tasklist /FI "IMAGENAME eq IO Checkout Tool.exe" 2>NUL | find /I /N "IO Checkout Tool.exe">NUL
if "%ERRORLEVEL%"=="0" (
    echo Backend is already running!
    goto :start_frontend
)

REM Start backend
echo [1/3] Starting backend server...
cd /d "%SCRIPT_DIR%backend"
start /MIN "IO-Checkout-Backend" "IO Checkout Tool.exe"
if errorlevel 1 (
    echo ERROR: Failed to start backend!
    pause
    exit /b 1
)

REM Wait for backend to initialize
echo [2/3] Waiting for backend to initialize...
timeout /t 5 /nobreak >nul

REM Check if backend is responding (simple check)
for /L %%i in (1,1,10) do (
    timeout /t 2 /nobreak >nul
    netstat -an | find "5000" >nul
    if not errorlevel 1 goto :backend_ready
)
:backend_ready

:start_frontend
REM Check for Node.js
set NODE_EXE=%SCRIPT_DIR%nodejs\node.exe
if not exist "%NODE_EXE%" (
    REM Try system Node.js
    where node >nul 2>&1
    if errorlevel 1 (
        echo ERROR: Node.js not found!
        echo Please install Node.js or place portable Node.js in nodejs folder.
        pause
        exit /b 1
    )
    set NODE_EXE=node
)

REM Start frontend
echo [3/3] Starting frontend server...
cd /d "%SCRIPT_DIR%frontend"
if exist "server.js" (
    start /MIN "IO-Checkout-Frontend" "%NODE_EXE%" server.js
) else if exist ".next\standalone\server.js" (
    cd .next\standalone
    start /MIN "IO-Checkout-Frontend" "%NODE_EXE%" server.js
) else (
    echo ERROR: Frontend server.js not found!
    pause
    exit /b 1
)

REM Wait for frontend
timeout /t 3 /nobreak >nul

REM Open browser
echo.
echo ========================================
echo   Application Started Successfully!
echo ========================================
echo   Backend:  http://localhost:5000
echo   Frontend: http://localhost:3000
echo ========================================
echo.
echo Opening browser in 3 seconds...
timeout /t 3 /nobreak >nul
start http://localhost:3000

echo.
echo Press any key to close this window (applications will keep running)...
pause >nul
"@

$startBat | Out-File -FilePath "$distributionFolder\START.bat" -Encoding ASCII

# STOP.bat
$stopBat = @"
@echo off
title IO Checkout Tool - Stopper
color 0C

echo ========================================
echo   Stopping IO Checkout Tool...
echo ========================================
echo.

echo Stopping backend...
taskkill /F /IM "IO Checkout Tool.exe" 2>nul
if errorlevel 1 (
    echo Backend was not running.
) else (
    echo Backend stopped.
)

echo.
echo Stopping frontend...
taskkill /F /FI "WINDOWTITLE eq IO-Checkout-Frontend*" 2>nul
taskkill /F /FI "WINDOWTITLE eq IO-Checkout-Backend*" 2>nul
for /f "tokens=2" %%a in ('tasklist ^| findstr /i "node.exe"') do (
    taskkill /F /PID %%a 2>nul
)

echo.
echo ========================================
echo   Application Stopped
echo ========================================
pause
"@

$stopBat | Out-File -FilePath "$distributionFolder\STOP.bat" -Encoding ASCII

# README.txt
$readme = @"
IO CHECKOUT TOOL - PORTABLE VERSION
====================================

QUICK START:
1. Double-click START.bat
2. Wait for both servers to start
3. Browser will open automatically

STOPPING:
- Double-click STOP.bat to stop both servers

NETWORK ACCESS:
- The application will be accessible on your network
- Backend: http://YOUR_IP:5000
- Frontend: http://YOUR_IP:3000

TROUBLESHOOTING:
- If backend fails to start, check config.json in backend folder
- If frontend fails, ensure Node.js is available (portable or installed)
- Check Windows Firewall if network access doesn't work

FILES:
- backend/ - C# .NET application (includes runtime)
- frontend/ - Next.js application
- nodejs/ - Portable Node.js runtime (if included)

SUPPORT:
Contact your IT department for assistance.
"@

$readme | Out-File -FilePath "$distributionFolder\README.txt" -Encoding ASCII

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Distribution Created Successfully!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Location: $distributionFolder" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1. Test START.bat on a clean machine" -ForegroundColor White
Write-Host "2. If Node.js portable is missing, download and extract to nodejs folder" -ForegroundColor White
Write-Host "3. Compress the folder for distribution (7zip recommended)" -ForegroundColor White
Write-Host ""

