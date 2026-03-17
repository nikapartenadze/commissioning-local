@echo off
setlocal enabledelayedexpansion

echo ============================================================
echo  IO Checkout Tool - Build Portable Distribution
echo  Builds a fully self-contained folder. No installs needed.
echo ============================================================
echo.

set "PROJECT_DIR=%~dp0.."
set "FRONTEND_DIR=%PROJECT_DIR%\frontend"
set "OUTPUT_DIR=%PROJECT_DIR%\portable"
set "TEMP_DIR=%PROJECT_DIR%\temp_build"

set "NODE_VER=v20.20.1"
set "NODE_DIR_NAME=node-%NODE_VER%-win-x64"
set "NODE_URL=https://nodejs.org/dist/%NODE_VER%/%NODE_DIR_NAME%.zip"
set "PLCTAG_VER=v2.6.15"
set "PLCTAG_URL=https://github.com/libplctag/libplctag/releases/download/%PLCTAG_VER%/libplctag_%PLCTAG_VER:~1%_windows_x64.zip"

if not exist "%TEMP_DIR%" mkdir "%TEMP_DIR%"

REM ══════════════════════════════════════════════════════════════
REM  Step 1: Ensure Node.js is available for building
REM ══════════════════════════════════════════════════════════════
echo [1/7] Checking Node.js for build...

where node >nul 2>nul
if %errorlevel% equ 0 (
    for /f "tokens=*" %%v in ('node --version') do set "BUILD_NODE_VER=%%v"
    echo   System Node.js found: !BUILD_NODE_VER!
    set "NODE_CMD=node"
    set "NPM_CMD=npm"
    set "NPX_CMD=npx"
) else (
    echo   Node.js not installed — downloading portable Node.js for build...
    call :DownloadNode
    if !errorlevel! neq 0 exit /b 1
    set "NODE_CMD=%TEMP_DIR%\%NODE_DIR_NAME%\node.exe"
    set "NPM_CMD=%TEMP_DIR%\%NODE_DIR_NAME%\npm.cmd"
    set "NPX_CMD=%TEMP_DIR%\%NODE_DIR_NAME%\npx.cmd"
    set "PATH=%TEMP_DIR%\%NODE_DIR_NAME%;!PATH!"
    echo   Using portable Node.js %NODE_VER%
)

REM ══════════════════════════════════════════════════════════════
REM  Step 2: Download libplctag DLL
REM ══════════════════════════════════════════════════════════════
echo [2/7] Checking libplctag native library...

if exist "%FRONTEND_DIR%\plctag.dll" (
    echo   plctag.dll found
) else (
    echo   Downloading plctag.dll...
    set "PLCTAG_ZIP=%TEMP_DIR%\libplctag.zip"
    powershell -NoProfile -Command "& { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%PLCTAG_URL%' -OutFile '!PLCTAG_ZIP!' }" 2>nul

    if not exist "!PLCTAG_ZIP!" (
        echo   ERROR: Failed to download libplctag.
        echo   Manually download plctag.dll from https://github.com/libplctag/libplctag/releases
        echo   and place it in: %FRONTEND_DIR%\
        pause
        exit /b 1
    )

    powershell -NoProfile -Command "& { Add-Type -A 'System.IO.Compression.FileSystem'; $zip = [IO.Compression.ZipFile]::OpenRead('!PLCTAG_ZIP!'); $entry = $zip.Entries | Where-Object { $_.Name -eq 'plctag.dll' }; [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, '%FRONTEND_DIR%\plctag.dll', $true); $zip.Dispose() }" 2>nul

    if exist "%FRONTEND_DIR%\plctag.dll" (
        echo   plctag.dll downloaded
    ) else (
        echo   ERROR: Failed to extract plctag.dll
        pause
        exit /b 1
    )
    del /q "!PLCTAG_ZIP!" 2>nul
)

REM ══════════════════════════════════════════════════════════════
REM  Step 3: Clean previous build
REM ══════════════════════════════════════════════════════════════
echo [3/7] Cleaning previous build...
if exist "%OUTPUT_DIR%" rmdir /s /q "%OUTPUT_DIR%"
mkdir "%OUTPUT_DIR%"

REM ══════════════════════════════════════════════════════════════
REM  Step 4: Install dependencies + Prisma
REM ══════════════════════════════════════════════════════════════
echo [4/7] Installing dependencies...
cd /d "%FRONTEND_DIR%"
call !NPM_CMD! ci --production=false
if %errorlevel% neq 0 ( echo ERROR: npm ci failed & pause & exit /b 1 )

echo [5/7] Generating Prisma client...
call !NPX_CMD! prisma generate
if %errorlevel% neq 0 ( echo ERROR: Prisma generate failed & pause & exit /b 1 )

REM ══════════════════════════════════════════════════════════════
REM  Step 5: Build Next.js
REM ══════════════════════════════════════════════════════════════
echo [6/7] Building Next.js (standalone)...
call !NPM_CMD! run build
if %errorlevel% neq 0 ( echo ERROR: Build failed & pause & exit /b 1 )

REM ══════════════════════════════════════════════════════════════
REM  Step 6: Download portable Node.js for distribution
REM ══════════════════════════════════════════════════════════════
echo [7/7] Assembling portable distribution...

REM Download portable Node.js to bundle
if not exist "%TEMP_DIR%\%NODE_DIR_NAME%\node.exe" (
    echo   Downloading Node.js %NODE_VER% for bundling...
    call :DownloadNode
    if !errorlevel! neq 0 exit /b 1
)

REM ── Bundle Node.js runtime ──
echo   Bundling Node.js runtime...
mkdir "%OUTPUT_DIR%\node" 2>nul
copy "%TEMP_DIR%\%NODE_DIR_NAME%\node.exe" "%OUTPUT_DIR%\node\" >nul
copy "%TEMP_DIR%\%NODE_DIR_NAME%\npm.cmd" "%OUTPUT_DIR%\node\" >nul
copy "%TEMP_DIR%\%NODE_DIR_NAME%\npx.cmd" "%OUTPUT_DIR%\node\" >nul
xcopy /E /I /Q "%TEMP_DIR%\%NODE_DIR_NAME%\node_modules" "%OUTPUT_DIR%\node\node_modules"

REM ── Copy app ──
echo   Copying application files...
xcopy /E /I /Q "%FRONTEND_DIR%\.next\standalone" "%OUTPUT_DIR%\app"
xcopy /E /I /Q "%FRONTEND_DIR%\.next\static" "%OUTPUT_DIR%\app\.next\static"
if exist "%FRONTEND_DIR%\public" xcopy /E /I /Q "%FRONTEND_DIR%\public" "%OUTPUT_DIR%\app\public"

REM WebSocket server + production server
mkdir "%OUTPUT_DIR%\app\scripts" 2>nul
copy "%FRONTEND_DIR%\scripts\plc-websocket-server.js" "%OUTPUT_DIR%\app\scripts\" >nul
copy "%FRONTEND_DIR%\server.js" "%OUTPUT_DIR%\app\" >nul

REM PLC native library
copy "%FRONTEND_DIR%\plctag.dll" "%OUTPUT_DIR%\app\" >nul

REM Prisma
xcopy /E /I /Q "%FRONTEND_DIR%\prisma" "%OUTPUT_DIR%\app\prisma"
xcopy /E /I /Q "%FRONTEND_DIR%\node_modules\.prisma" "%OUTPUT_DIR%\app\node_modules\.prisma"
xcopy /E /I /Q "%FRONTEND_DIR%\node_modules\@prisma" "%OUTPUT_DIR%\app\node_modules\@prisma"

REM ws module
xcopy /E /I /Q "%FRONTEND_DIR%\node_modules\ws" "%OUTPUT_DIR%\app\node_modules\ws"

REM Seed script
copy "%FRONTEND_DIR%\prisma\seed-diagnostics.ts" "%OUTPUT_DIR%\app\prisma\" 2>nul

REM ── Create .env ──
(
echo DATABASE_URL=file:./database.db
echo JWT_SECRET_KEY=io-checkout-%RANDOM%%RANDOM%%RANDOM%
echo PLC_WS_PORT=3002
echo PORT=3000
echo HOSTNAME=0.0.0.0
echo NODE_ENV=production
) > "%OUTPUT_DIR%\app\.env"

REM ══════════════════════════════════════════════════════════════
REM  Generate runtime scripts that use bundled Node.js
REM ══════════════════════════════════════════════════════════════

REM ── START.bat ──
(
echo @echo off
echo setlocal
echo set "ROOT=%%~dp0"
echo set "NODE=%%ROOT%%node\node.exe"
echo set "NPX=%%ROOT%%node\npx.cmd"
echo set "PATH=%%ROOT%%node;%%PATH%%"
echo set "APP=%%ROOT%%app"
echo.
echo REM Initialize database if first run
echo if not exist "%%APP%%\database.db" ^(
echo     echo First run — initializing database...
echo     cd /d "%%APP%%"
echo     call "%%NPX%%" prisma db push --skip-generate 2^>nul
echo     echo Database created.
echo     echo.
echo ^)
echo.
echo echo ============================================================
echo echo  IO Checkout Tool
echo echo ============================================================
echo echo.
echo echo   App:        http://localhost:3000
echo echo   WebSocket:  ws://localhost:3002
echo echo   Admin PIN:  852963
echo echo.
echo REM Show IP addresses
echo echo   Tablet access:
echo for /f "tokens=2 delims=:" %%%%a in ^('ipconfig ^^^| findstr /i "IPv4"'^) do ^(
echo     for /f "tokens=1" %%%%b in ^("%%%%a"^) do ^(
echo         echo     http://%%%%b:3000
echo     ^)
echo ^)
echo echo.
echo echo   Press Ctrl+C to stop.
echo echo ============================================================
echo.
echo cd /d "%%APP%%"
echo "%%NODE%%" server.js
) > "%OUTPUT_DIR%\START.bat"

REM ── STOP.bat ──
(
echo @echo off
echo echo Stopping IO Checkout Tool...
echo taskkill /f /im "node.exe" /fi "MEMUSAGE gt 50000" 2^>nul
echo echo Stopped.
echo timeout /t 2 ^>nul
) > "%OUTPUT_DIR%\STOP.bat"

REM ── STATUS.bat ──
(
echo @echo off
echo echo ============================================================
echo echo  IO Checkout Tool - Status
echo echo ============================================================
echo echo.
echo netstat -an ^| findstr ":3000 " ^| findstr "LISTENING" ^>nul 2^>nul
echo if %%errorlevel%% equ 0 ^(echo   App ^(port 3000^):       RUNNING^) else ^(echo   App ^(port 3000^):       NOT RUNNING^)
echo netstat -an ^| findstr ":3002 " ^| findstr "LISTENING" ^>nul 2^>nul
echo if %%errorlevel%% equ 0 ^(echo   WebSocket ^(port 3002^): RUNNING^) else ^(echo   WebSocket ^(port 3002^): NOT RUNNING^)
echo echo.
echo echo Tablet access URLs:
echo for /f "tokens=2 delims=:" %%%%a in ^('ipconfig ^^^| findstr /i "IPv4"'^) do ^(
echo     for /f "tokens=1" %%%%b in ^("%%%%a"^) do ^(
echo         echo   http://%%%%b:3000
echo     ^)
echo ^)
echo echo.
echo pause
) > "%OUTPUT_DIR%\STATUS.bat"

REM ── SETUP-FIREWALL.bat ──
copy "%~dp0SETUP-FIREWALL.bat" "%OUTPUT_DIR%\" >nul

REM ── SEED-DIAGNOSTICS.bat ──
(
echo @echo off
echo set "ROOT=%%~dp0"
echo set "PATH=%%ROOT%%node;%%PATH%%"
echo echo Seeding diagnostic troubleshooting data...
echo cd /d "%%ROOT%%app"
echo call "%%ROOT%%node\npx.cmd" tsx prisma/seed-diagnostics.ts
echo echo Done.
echo pause
) > "%OUTPUT_DIR%\SEED-DIAGNOSTICS.bat"

REM ── README.txt ──
(
echo IO Checkout Tool - Portable Distribution
echo =========================================
echo.
echo ZERO INSTALL REQUIRED. Everything is included.
echo.
echo FIRST TIME SETUP:
echo   1. Run SETUP-FIREWALL.bat as Administrator ^(right-click ^> Run as admin^)
echo      This opens ports 3000 and 3002 so tablets can connect.
echo   2. Run SEED-DIAGNOSTICS.bat ^(optional — adds troubleshooting help data^)
echo   3. Run START.bat
echo.
echo DAILY USE:
echo   START.bat    — Launch the app ^(database auto-creates on first run^)
echo   STOP.bat     — Stop the app
echo   STATUS.bat   — Check if running, show tablet access URLs
echo.
echo ACCESS:
echo   On this PC:  http://localhost:3000
echo   On tablets:  http://THIS_PC_IP:3000  ^(run STATUS.bat to see the IP^)
echo   Admin PIN:   852963
echo.
echo PORTS:
echo   3000  — Web app ^(HTTP^)
echo   3002  — WebSocket ^(real-time PLC updates^)
echo.
echo TROUBLESHOOTING:
echo   - If tablets can't connect, run SETUP-FIREWALL.bat as Administrator
echo   - If PLC won't connect, check IP address and that PLC is on the network
echo   - App data is stored in app\database.db ^(auto-backed up before cloud pulls^)
) > "%OUTPUT_DIR%\README.txt"

REM ── Cleanup ──
if exist "%TEMP_DIR%" rmdir /s /q "%TEMP_DIR%"

echo.
echo ============================================================
echo  BUILD COMPLETE
echo ============================================================
echo.
echo Output: %OUTPUT_DIR%
echo.
echo This folder is 100%% self-contained. No installs needed.
echo Copy it to any Windows PC and double-click START.bat.
echo.
echo First time on a new machine:
echo   1. SETUP-FIREWALL.bat  (as Admin, once)
echo   2. START.bat
echo.
pause
exit /b 0

REM ══════════════════════════════════════════════════════════════
REM  Subroutine: Download portable Node.js
REM ══════════════════════════════════════════════════════════════
:DownloadNode
set "NODE_ZIP=%TEMP_DIR%\node.zip"
if not exist "%TEMP_DIR%" mkdir "%TEMP_DIR%"

if exist "%TEMP_DIR%\%NODE_DIR_NAME%\node.exe" (
    echo   Node.js already downloaded
    exit /b 0
)

echo   Downloading Node.js %NODE_VER% (this may take a minute)...
powershell -NoProfile -Command "& { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%NODE_ZIP%' }" 2>nul

if not exist "%NODE_ZIP%" (
    echo   ERROR: Failed to download Node.js from %NODE_URL%
    echo   Check your internet connection.
    pause
    exit /b 1
)

echo   Extracting Node.js...
powershell -NoProfile -Command "& { Expand-Archive -Path '%NODE_ZIP%' -DestinationPath '%TEMP_DIR%' -Force }" 2>nul

if not exist "%TEMP_DIR%\%NODE_DIR_NAME%\node.exe" (
    echo   ERROR: Failed to extract Node.js
    pause
    exit /b 1
)

del /q "%NODE_ZIP%" 2>nul
echo   Node.js %NODE_VER% ready
exit /b 0
