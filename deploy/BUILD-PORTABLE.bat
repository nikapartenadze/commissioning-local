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
xcopy /E /I /Q /Y "%TEMP_DIR%\%NODE_DIR_NAME%\node_modules" "%OUTPUT_DIR%\node\node_modules"

REM ── Copy app ──
echo   Copying application files...
xcopy /E /I /Q /Y "%FRONTEND_DIR%\.next\standalone" "%OUTPUT_DIR%\app"
xcopy /E /I /Q /Y "%FRONTEND_DIR%\.next\static" "%OUTPUT_DIR%\app\.next\static"
if exist "%FRONTEND_DIR%\public" xcopy /E /I /Q /Y "%FRONTEND_DIR%\public" "%OUTPUT_DIR%\app\public"

REM Preserve standalone server before overwriting with custom server
if exist "%OUTPUT_DIR%\app\server.js" (
    copy "%OUTPUT_DIR%\app\server.js" "%OUTPUT_DIR%\app\next-server.js" >nul
)

REM Production server (WebSocket server is merged in)
copy "%FRONTEND_DIR%\server.js" "%OUTPUT_DIR%\app\" >nul

REM PLC native library
copy "%FRONTEND_DIR%\plctag.dll" "%OUTPUT_DIR%\app\" >nul

REM Prisma schema (kept for seed scripts, not used at runtime)
xcopy /E /I /Q /Y "%FRONTEND_DIR%\prisma" "%OUTPUT_DIR%\app\prisma"

REM ws module
xcopy /E /I /Q /Y "%FRONTEND_DIR%\node_modules\ws" "%OUTPUT_DIR%\app\node_modules\ws"

REM better-sqlite3 (native module — must be built for bundled Node.js ABI)
echo   Installing better-sqlite3 for Node.js %NODE_VER%...
set "PORTABLE_NODE=%OUTPUT_DIR%\node\node.exe"
set "PORTABLE_NPM=%OUTPUT_DIR%\node\node_modules\npm\bin\npm-cli.js"
REM Build in isolated temp dir to avoid polluting portable node_modules
if exist "%TEMP_DIR%\sqlite-build" rmdir /s /q "%TEMP_DIR%\sqlite-build"
mkdir "%TEMP_DIR%\sqlite-build"
pushd "%TEMP_DIR%\sqlite-build"
set "npm_config_nodedir=%OUTPUT_DIR%\node"
set "PATH=%OUTPUT_DIR%\node;%PATH%"
"%PORTABLE_NODE%" "%PORTABLE_NPM%" init -y >nul 2>nul
"%PORTABLE_NODE%" "%PORTABLE_NPM%" install better-sqlite3 --no-save 2>nul
set "npm_config_nodedir="
REM Verify it works with bundled Node
"%PORTABLE_NODE%" -e "require('better-sqlite3')" 2>nul
if %errorlevel% neq 0 (
    echo   WARNING: better-sqlite3 build failed for Node.js %NODE_VER% — copying from dev...
    xcopy /E /I /Q /Y "%FRONTEND_DIR%\node_modules\better-sqlite3" "%OUTPUT_DIR%\app\node_modules\better-sqlite3"
) else (
    echo   better-sqlite3 compiled successfully for Node.js %NODE_VER%
    xcopy /E /I /Q /Y "%TEMP_DIR%\sqlite-build\node_modules\better-sqlite3" "%OUTPUT_DIR%\app\node_modules\better-sqlite3"
)
popd
REM Copy bindings dependency (needed by better-sqlite3 to find .node file)
xcopy /E /I /Q /Y "%FRONTEND_DIR%\node_modules\bindings" "%OUTPUT_DIR%\app\node_modules\bindings"
xcopy /E /I /Q /Y "%FRONTEND_DIR%\node_modules\file-uri-to-path" "%OUTPUT_DIR%\app\node_modules\file-uri-to-path" 2>nul
rmdir /s /q "%TEMP_DIR%\sqlite-build" 2>nul

REM http-proxy module (for standalone WebSocket upgrade proxy)
xcopy /E /I /Q /Y "%FRONTEND_DIR%\node_modules\http-proxy" "%OUTPUT_DIR%\app\node_modules\http-proxy"
xcopy /E /I /Q /Y "%FRONTEND_DIR%\node_modules\eventemitter3" "%OUTPUT_DIR%\app\node_modules\eventemitter3" 2>nul
xcopy /E /I /Q /Y "%FRONTEND_DIR%\node_modules\requires-port" "%OUTPUT_DIR%\app\node_modules\requires-port" 2>nul
xcopy /E /I /Q /Y "%FRONTEND_DIR%\node_modules\follow-redirects" "%OUTPUT_DIR%\app\node_modules\follow-redirects" 2>nul

REM Startup backup module
copy "%FRONTEND_DIR%\lib\startup-backup.js" "%OUTPUT_DIR%\app\lib\" 2>nul
if not exist "%OUTPUT_DIR%\app\lib" mkdir "%OUTPUT_DIR%\app\lib"
copy "%FRONTEND_DIR%\lib\startup-backup.js" "%OUTPUT_DIR%\app\lib\" 2>nul

REM Seed scripts
copy "%FRONTEND_DIR%\prisma\seed-diagnostics.ts" "%OUTPUT_DIR%\app\prisma\" 2>nul
copy "%FRONTEND_DIR%\prisma\seed-network.ts" "%OUTPUT_DIR%\app\prisma\" 2>nul

REM Test plan docs
copy "%PROJECT_DIR%\TEST-PLAN.xlsx" "%OUTPUT_DIR%\" 2>nul
copy "%PROJECT_DIR%\TEST-PLAN.html" "%OUTPUT_DIR%\" 2>nul
copy "%PROJECT_DIR%\TEST-PLAN.md" "%OUTPUT_DIR%\" 2>nul

REM ── Create .env ──
(
echo DATABASE_URL=file:../database.db
echo JWT_SECRET_KEY=io-checkout-%RANDOM%%RANDOM%%RANDOM%
echo PORT=3000
echo HOSTNAME=0.0.0.0
echo NODE_ENV=production
) > "%OUTPUT_DIR%\app\.env"

REM ── Initialize database with schema ──
echo   Initializing database...
cd /d "%FRONTEND_DIR%"
set "DATABASE_URL=file:%OUTPUT_DIR%\app\database.db"
call !NPX_CMD! prisma db push --skip-generate
if %errorlevel% neq 0 ( echo WARNING: Database init failed — will retry on first START & set "DATABASE_URL=" )
set "DATABASE_URL="

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
echo REM ── Auto-setup firewall rules if not present ──
echo netsh advfirewall firewall show rule name="IO Checkout - App" ^>nul 2^>^&1
echo if %%errorlevel%% neq 0 ^(
echo     echo Setting up firewall rules...
echo     net session ^>nul 2^>^&1
echo     if %%errorlevel%% neq 0 ^(
echo         echo Requesting administrator access for firewall setup...
echo         powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%%~dp0SETUP-FIREWALL.bat'" 2^>nul
echo     ^) else ^(
echo         netsh advfirewall firewall add rule name="IO Checkout - App" dir=in action=allow protocol=tcp localport=3000 ^>nul
echo         echo Firewall rules added.
echo     ^)
echo ^)
echo.
echo REM ── Check database ──
echo if not exist "%%APP%%\database.db" ^(
echo     echo ERROR: database.db is missing. Please re-run BUILD-PORTABLE.bat.
echo     pause
echo     exit /b 1
echo ^)
echo.
echo echo ============================================================
echo echo  IO Checkout Tool
echo echo ============================================================
echo echo.
echo echo   App:        http://localhost:3000
echo echo   Admin PIN:  111111
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
echo echo.
echo echo Server stopped unexpectedly.
echo pause
) > "%OUTPUT_DIR%\START.bat"

REM ── STATUS.bat ──
(
echo @echo off
echo echo ============================================================
echo echo  IO Checkout Tool - Status
echo echo ============================================================
echo echo.
echo netstat -an ^| findstr ":3000 " ^| findstr "LISTENING" ^>nul 2^>nul
echo if %%errorlevel%% equ 0 ^(echo   App ^(port 3000^):       RUNNING^) else ^(echo   App ^(port 3000^):       NOT RUNNING^)
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

REM ── SEED-NETWORK.bat ──
(
echo @echo off
echo setlocal
echo set "ROOT=%%~dp0"
echo set "NODE=%%ROOT%%node\node.exe"
echo set "NPX=%%ROOT%%node\npx.cmd"
echo set "PATH=%%ROOT%%node;%%PATH%%"
echo set "APP=%%ROOT%%app"
echo echo.
echo echo Seeding network topology data...
echo cd /d "%%APP%%"
echo "%%NPX%%" tsx prisma/seed-network.ts
echo if %%errorlevel%% equ 0 ^(echo Network data seeded successfully.^) else ^(echo ERROR: Seeding failed.^)
echo echo.
echo pause
) > "%OUTPUT_DIR%\SEED-NETWORK.bat"

REM ── README.txt ──
(
echo IO Checkout Tool - Portable Distribution
echo =========================================
echo.
echo ZERO INSTALL REQUIRED. Everything is included.
echo.
echo FIRST TIME SETUP:
echo   1. Double-click START.bat
echo      ^(Firewall, database, and diagnostic help data are set up automatically^)
echo.
echo DAILY USE:
echo   START.bat    — Launch the app ^(close the window to stop^)
echo   STATUS.bat   — Check if running, show tablet access URLs
echo.
echo ACCESS:
echo   On this PC:  http://localhost:3000
echo   On tablets:  http://THIS_PC_IP:3000  ^(run STATUS.bat to see the IP^)
echo   Admin PIN:   111111
echo.
echo PORTS:
echo   3000  — Web app + WebSocket ^(HTTP + real-time PLC updates^)
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
