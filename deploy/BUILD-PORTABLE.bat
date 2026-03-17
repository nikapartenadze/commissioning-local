@echo off
setlocal enabledelayedexpansion

echo ============================================================
echo  IO Checkout Tool - Build Portable Distribution
echo ============================================================
echo.

REM ── Check prerequisites ──
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed.
    echo Download from: https://nodejs.org
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo Node.js version: %NODE_VER%

set "PROJECT_DIR=%~dp0.."
set "FRONTEND_DIR=%PROJECT_DIR%\frontend"
set "OUTPUT_DIR=%PROJECT_DIR%\portable"
set "TEMP_DIR=%PROJECT_DIR%\temp_build"

echo Project: %PROJECT_DIR%
echo Output:  %OUTPUT_DIR%
echo.

REM ── Step 1: Download libplctag if not present ──
echo [1/6] Checking libplctag native library...

if exist "%FRONTEND_DIR%\plctag.dll" (
    echo   plctag.dll found in frontend/
) else (
    echo   plctag.dll not found — downloading...

    REM Try PowerShell download (works on all modern Windows)
    set "PLCTAG_URL=https://github.com/libplctag/libplctag/releases/download/v2.6.15/libplctag_2.6.15_windows_x64.zip"
    set "PLCTAG_ZIP=%TEMP_DIR%\libplctag.zip"

    if not exist "%TEMP_DIR%" mkdir "%TEMP_DIR%"

    echo   Downloading from GitHub...
    powershell -NoProfile -Command "& { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%PLCTAG_URL%' -OutFile '%PLCTAG_ZIP%' }" 2>nul

    if not exist "!PLCTAG_ZIP!" (
        echo   ERROR: Failed to download libplctag.
        echo   Please manually download plctag.dll from:
        echo   https://github.com/libplctag/libplctag/releases
        echo   and place it in: %FRONTEND_DIR%\
        pause
        exit /b 1
    )

    echo   Extracting plctag.dll...
    powershell -NoProfile -Command "& { Add-Type -A 'System.IO.Compression.FileSystem'; $zip = [IO.Compression.ZipFile]::OpenRead('%PLCTAG_ZIP%'); $entry = $zip.Entries | Where-Object { $_.Name -eq 'plctag.dll' }; [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, '%FRONTEND_DIR%\plctag.dll', $true); $zip.Dispose() }" 2>nul

    if exist "%FRONTEND_DIR%\plctag.dll" (
        echo   plctag.dll downloaded successfully
    ) else (
        echo   ERROR: Failed to extract plctag.dll
        pause
        exit /b 1
    )

    REM Cleanup temp
    del /q "!PLCTAG_ZIP!" 2>nul
)

REM ── Step 2: Clean previous build ──
echo [2/6] Cleaning previous build...
if exist "%OUTPUT_DIR%" rmdir /s /q "%OUTPUT_DIR%"
mkdir "%OUTPUT_DIR%"

REM ── Step 3: Install dependencies ──
echo [3/6] Installing dependencies...
cd /d "%FRONTEND_DIR%"
call npm ci --production=false
if %errorlevel% neq 0 (
    echo ERROR: npm ci failed
    pause
    exit /b 1
)

REM ── Step 4: Generate Prisma client ──
echo [4/6] Generating Prisma client...
call npx prisma generate
if %errorlevel% neq 0 (
    echo ERROR: Prisma generate failed
    pause
    exit /b 1
)

REM ── Step 5: Build Next.js ──
echo [5/6] Building Next.js (standalone)...
call npm run build
if %errorlevel% neq 0 (
    echo ERROR: Build failed
    pause
    exit /b 1
)

REM ── Step 6: Assemble portable distribution ──
echo [6/6] Assembling portable distribution...

REM Copy standalone output
xcopy /E /I /Q "%FRONTEND_DIR%\.next\standalone" "%OUTPUT_DIR%\app"

REM Copy static assets
xcopy /E /I /Q "%FRONTEND_DIR%\.next\static" "%OUTPUT_DIR%\app\.next\static"

REM Copy public folder
if exist "%FRONTEND_DIR%\public" (
    xcopy /E /I /Q "%FRONTEND_DIR%\public" "%OUTPUT_DIR%\app\public"
)

REM Copy PLC WebSocket server
mkdir "%OUTPUT_DIR%\app\scripts" 2>nul
copy "%FRONTEND_DIR%\scripts\plc-websocket-server.js" "%OUTPUT_DIR%\app\scripts\"

REM Copy production server
copy "%FRONTEND_DIR%\server.js" "%OUTPUT_DIR%\app\"

REM Copy native PLC library
copy "%FRONTEND_DIR%\plctag.dll" "%OUTPUT_DIR%\app\"

REM Copy Prisma schema and generated client
xcopy /E /I /Q "%FRONTEND_DIR%\prisma" "%OUTPUT_DIR%\app\prisma"
xcopy /E /I /Q "%FRONTEND_DIR%\node_modules\.prisma" "%OUTPUT_DIR%\app\node_modules\.prisma"
xcopy /E /I /Q "%FRONTEND_DIR%\node_modules\@prisma" "%OUTPUT_DIR%\app\node_modules\@prisma"

REM Copy ws module (for WebSocket server)
xcopy /E /I /Q "%FRONTEND_DIR%\node_modules\ws" "%OUTPUT_DIR%\app\node_modules\ws"

REM Copy startup/management scripts
copy "%~dp0START.bat" "%OUTPUT_DIR%\"
copy "%~dp0STOP.bat" "%OUTPUT_DIR%\"
copy "%~dp0STATUS.bat" "%OUTPUT_DIR%\"
copy "%~dp0SETUP-FIREWALL.bat" "%OUTPUT_DIR%\"

REM Copy seed script for diagnostics
copy "%FRONTEND_DIR%\prisma\seed-diagnostics.ts" "%OUTPUT_DIR%\app\prisma\" 2>nul

REM Create default .env
(
echo DATABASE_URL=file:./database.db
echo JWT_SECRET_KEY=change-this-in-production-%RANDOM%%RANDOM%
echo PLC_WS_PORT=3002
echo PORT=3000
echo HOSTNAME=0.0.0.0
echo NODE_ENV=production
) > "%OUTPUT_DIR%\app\.env"

REM Create FIRST-TIME-SETUP.bat inside portable
(
echo @echo off
echo echo ============================================================
echo echo  IO Checkout Tool - First Time Setup
echo echo ============================================================
echo echo.
echo echo Initializing database...
echo cd /d "%%~dp0app"
echo call npx prisma db push --skip-generate
echo echo.
echo echo Seeding diagnostic data ^(troubleshooting steps^)...
echo call npx tsx prisma/seed-diagnostics.ts 2^>nul ^|^| echo   Skipped ^(optional^)
echo echo.
echo echo Setup complete! Run START.bat to launch.
echo echo Default admin PIN: 852963
echo echo.
echo pause
) > "%OUTPUT_DIR%\FIRST-TIME-SETUP.bat"

REM Create README inside portable
(
echo IO Checkout Tool - Portable Distribution
echo =========================================
echo.
echo FIRST TIME:
echo   1. Install Node.js 20+ from https://nodejs.org
echo   2. Run SETUP-FIREWALL.bat as Administrator ^(once^)
echo   3. Run FIRST-TIME-SETUP.bat ^(once^)
echo   4. Run START.bat
echo.
echo DAILY USE:
echo   - START.bat   — Start the app
echo   - STOP.bat    — Stop the app
echo   - STATUS.bat  — Check if running, show IP addresses
echo.
echo ACCESS:
echo   - Open http://localhost:3000 on this PC
echo   - Tablets connect to http://THIS_PC_IP:3000
echo   - Run STATUS.bat to see the IP address
echo   - Default admin PIN: 852963
echo.
echo PORTS:
echo   - 3000  Web app
echo   - 3002  WebSocket ^(real-time PLC updates^)
) > "%OUTPUT_DIR%\README.txt"

REM Cleanup temp dir
if exist "%TEMP_DIR%" rmdir /s /q "%TEMP_DIR%"

echo.
echo ============================================================
echo  BUILD COMPLETE
echo ============================================================
echo.
echo Output: %OUTPUT_DIR%
echo.
echo Contents:
echo   FIRST-TIME-SETUP.bat  - Run once on new machine
echo   SETUP-FIREWALL.bat    - Run once as Admin to open ports
echo   START.bat             - Start the app
echo   STOP.bat              - Stop the app
echo   STATUS.bat            - Check status and show IPs
echo   README.txt            - Instructions
echo   app\                  - Application files
echo.
echo To deploy:
echo   1. Copy the "portable" folder to the factory server
echo   2. Install Node.js 20+ on the server
echo   3. Run FIRST-TIME-SETUP.bat (once)
echo   4. Run START.bat
echo   5. Open http://SERVER_IP:3000 on tablets
echo.
pause
