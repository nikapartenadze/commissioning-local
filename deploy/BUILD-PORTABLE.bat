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
set "SQLITE3_VER=12.8.0"
set "NODE_ABI=115"
set "PLCTAG_VER=v2.6.15"
set "PLCTAG_URL=https://github.com/libplctag/libplctag/releases/download/%PLCTAG_VER%/libplctag_%PLCTAG_VER:~1%_windows_x64.zip"

if not exist "%TEMP_DIR%" mkdir "%TEMP_DIR%"

REM ══════════════════════════════════════════════════════════════
REM  Step 1: Ensure Node.js is available for building
REM ══════════════════════════════════════════════════════════════
echo [1/8] Checking Node.js for build...

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
echo [2/8] Checking libplctag native library...

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
echo [3/8] Cleaning previous build...
if exist "%OUTPUT_DIR%" rmdir /s /q "%OUTPUT_DIR%"
mkdir "%OUTPUT_DIR%"
REM Clear previous build outputs to ensure fresh compilation
if exist "%FRONTEND_DIR%\dist" rmdir /s /q "%FRONTEND_DIR%\dist"
if exist "%FRONTEND_DIR%\dist-server" rmdir /s /q "%FRONTEND_DIR%\dist-server"

REM ══════════════════════════════════════════════════════════════
REM  Step 4: Install dependencies + Prisma
REM ══════════════════════════════════════════════════════════════
echo [4/8] Installing dependencies...
cd /d "%FRONTEND_DIR%"
call !NPM_CMD! ci --production=false
if %errorlevel% neq 0 ( echo ERROR: npm ci failed & pause & exit /b 1 )

echo [5/8] Generating Prisma client...
call !NPX_CMD! prisma generate
if %errorlevel% neq 0 ( echo ERROR: Prisma generate failed & pause & exit /b 1 )

REM ══════════════════════════════════════════════════════════════
REM  Step 5: Build Vite (client) + TypeScript (server)
REM ══════════════════════════════════════════════════════════════
echo [6/8] Building Vite client bundle...
call !NPM_CMD! run build
if %errorlevel% neq 0 ( echo ERROR: Vite build failed & pause & exit /b 1 )

echo [7/8] Compiling Express server...
call !NPM_CMD! run build:server
if %errorlevel% neq 0 ( echo ERROR: Server compilation failed & pause & exit /b 1 )

REM ══════════════════════════════════════════════════════════════
REM  Step 6: Download portable Node.js for distribution
REM ══════════════════════════════════════════════════════════════
echo [8/8] Assembling portable distribution...

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

REM ── Copy compiled server (dist-server/) ──
echo   Copying compiled server...
xcopy /E /I /Q /Y "%FRONTEND_DIR%\dist-server" "%OUTPUT_DIR%\app\dist-server"

REM ── Copy Vite static output into dist-server/dist/ (server uses __dirname/dist) ──
echo   Copying Vite client bundle...
xcopy /E /I /Q /Y "%FRONTEND_DIR%\dist" "%OUTPUT_DIR%\app\dist-server\dist"

REM ── Copy startup-backup.js (plain JS, not compiled by tsc) ──
if not exist "%OUTPUT_DIR%\app\dist-server\lib" mkdir "%OUTPUT_DIR%\app\dist-server\lib"
copy "%FRONTEND_DIR%\lib\startup-backup.js" "%OUTPUT_DIR%\app\dist-server\lib\" >nul 2>nul

REM Remove dev artifacts that shouldn't be in portable
if exist "%OUTPUT_DIR%\app\dist-server\backups" rmdir /s /q "%OUTPUT_DIR%\app\dist-server\backups"
if exist "%OUTPUT_DIR%\app\dist-server\logs" rmdir /s /q "%OUTPUT_DIR%\app\dist-server\logs"
del "%OUTPUT_DIR%\app\dist-server\database.db" 2>nul
del "%OUTPUT_DIR%\app\dist-server\database.db-wal" 2>nul
del "%OUTPUT_DIR%\app\dist-server\database.db-shm" 2>nul

REM ── Copy node_modules using robocopy (handles long paths unlike xcopy) ──
echo   Copying node_modules (this may take a moment)...
robocopy "%FRONTEND_DIR%\node_modules" "%OUTPUT_DIR%\app\dist-server\node_modules" /E /NFL /NDL /NJH /NJS /NC /NS /NP /R:0 /W:0 >nul 2>nul
REM robocopy exit codes 0-7 are success/info, 8+ are errors
if %errorlevel% geq 8 ( echo WARNING: robocopy had errors copying node_modules )

REM ── Strip build-only + heavy packages not needed at runtime ──
echo   Stripping build-only packages...
for %%P in (
    typescript @typescript-eslint
    eslint eslint-scope eslint-visitor-keys @eslint eslint-config-next
    tailwindcss postcss autoprefixer lightningcss-win32-x64-msvc lightningcss
    prisma @prisma\engines @prisma\fetch-engine @prisma\get-platform @prisma\engines-version @prisma\debug
    @esbuild esbuild
    @swc @next next next-auth
    caniuse-lite
    @remotion remotion playwright playwright-core
    vite @vitejs @rolldown @rspack
    @mediabunny mediabunny
    concurrently tsx
    vitest @vitest
    webpack terser terser-webpack-plugin @webassemblyjs watchpack jest-worker
    acorn webpack-sources neo-async tapable
    @next\swc-win32-x64-msvc
    @types
    react react-dom
    recharts date-fns lucide-react
    @radix-ui @tanstack
    react-joyride react-markdown react-router react-router-dom
    clsx tailwind-merge tailwindcss-animate
    zustand class-variance-authority
    rxjs popper.js @floating-ui
    prettier @babel .cache jiti
) do (
    if exist "%OUTPUT_DIR%\app\dist-server\node_modules\%%P" (
        rmdir /s /q "%OUTPUT_DIR%\app\dist-server\node_modules\%%P" 2>nul
    )
)

REM PLC native library (at app/ level where cwd is set + inside dist-server/ for __dirname search)
copy "%FRONTEND_DIR%\plctag.dll" "%OUTPUT_DIR%\app\" >nul
copy "%FRONTEND_DIR%\plctag.dll" "%OUTPUT_DIR%\app\dist-server\" >nul

REM Prisma schema (needed by @prisma/client at runtime)
xcopy /E /I /Q /Y "%FRONTEND_DIR%\prisma" "%OUTPUT_DIR%\app\prisma"

REM better-sqlite3 — download prebuilt native binary for bundled Node.js
REM SQLITE3_VER and NODE_ABI are set at the top of this script
echo   Downloading prebuilt better-sqlite3 v%SQLITE3_VER% for Node.js %NODE_VER% (ABI %NODE_ABI%)...
set "PREBUILT_URL=https://github.com/WiseLibs/better-sqlite3/releases/download/v%SQLITE3_VER%/better-sqlite3-v%SQLITE3_VER%-node-v%NODE_ABI%-win32-x64.tar.gz"
set "PREBUILT_TAR=%TEMP_DIR%\sqlite3-prebuilt.tar.gz"
powershell -NoProfile -Command "& { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%PREBUILT_URL%' -OutFile '%PREBUILT_TAR%' }" 2>nul
if exist "%PREBUILT_TAR%" (
    pushd "%TEMP_DIR%"
    tar xzf sqlite3-prebuilt.tar.gz 2>nul
    if exist "build\Release\better_sqlite3.node" (
        copy /Y "build\Release\better_sqlite3.node" "%OUTPUT_DIR%\app\dist-server\node_modules\better-sqlite3\build\Release\better_sqlite3.node" >nul
        echo   Prebuilt binary installed for Node.js %NODE_VER%
    ) else (
        echo   WARNING: Failed to extract prebuilt binary
    )
    rmdir /s /q build 2>nul
    del /q sqlite3-prebuilt.tar.gz 2>nul
    popd
) else (
    echo   WARNING: Failed to download prebuilt binary
)

REM Seed scripts
copy "%FRONTEND_DIR%\prisma\seed-diagnostics.ts" "%OUTPUT_DIR%\app\prisma\" 2>nul
copy "%FRONTEND_DIR%\prisma\seed-network.ts" "%OUTPUT_DIR%\app\prisma\" 2>nul

REM Test plan docs
copy "%PROJECT_DIR%\TEST-PLAN.xlsx" "%OUTPUT_DIR%\" 2>nul
copy "%PROJECT_DIR%\TEST-PLAN.html" "%OUTPUT_DIR%\" 2>nul
copy "%PROJECT_DIR%\TEST-PLAN.md" "%OUTPUT_DIR%\" 2>nul

REM ── Create .env (inside dist-server/ where server-express.js reads it) ──
(
echo DATABASE_URL=file:../database.db
echo JWT_SECRET_KEY=io-checkout-%RANDOM%%RANDOM%%RANDOM%
echo PORT=3000
echo HOSTNAME=0.0.0.0
echo NODE_ENV=production
) > "%OUTPUT_DIR%\app\dist-server\.env"

REM ── Database ──
REM Schema is created automatically by db-sqlite.ts on first server start.
REM No need for prisma db push — the Express server handles it.

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
echo REM Database is created automatically on first start
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
echo "%%NODE%%" --max-old-space-size=256 --optimize-for-size dist-server\server-express.js
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
