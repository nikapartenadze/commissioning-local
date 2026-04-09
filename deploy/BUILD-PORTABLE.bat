@echo off
setlocal enabledelayedexpansion

echo ============================================================
echo  IO Checkout Tool - Build Portable Distribution
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
echo [1/6] Checking Node.js...

where node >nul 2>nul
if %errorlevel% equ 0 (
    for /f "tokens=*" %%v in ('node --version') do set "BUILD_NODE_VER=%%v"
    echo   System Node.js: !BUILD_NODE_VER!
    set "NODE_CMD=node"
    set "NPM_CMD=npm"
) else (
    if not exist "%TEMP_DIR%\%NODE_DIR_NAME%\node.exe" call :DownloadNode
    set "NODE_CMD=%TEMP_DIR%\%NODE_DIR_NAME%\node.exe"
    set "NPM_CMD=%TEMP_DIR%\%NODE_DIR_NAME%\npm.cmd"
    set "PATH=%TEMP_DIR%\%NODE_DIR_NAME%;!PATH!"
    echo   Using portable Node.js %NODE_VER%
)

REM ══════════════════════════════════════════════════════════════
REM  Step 2: Download plctag.dll if missing
REM ══════════════════════════════════════════════════════════════
echo [2/6] Checking plctag.dll...
if exist "%FRONTEND_DIR%\plctag.dll" (
    echo   Found
) else (
    echo   Downloading...
    set "PLCTAG_ZIP=%TEMP_DIR%\libplctag.zip"
    powershell -NoProfile -Command "& { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%PLCTAG_URL%' -OutFile '!PLCTAG_ZIP!' }" 2>nul
    if exist "!PLCTAG_ZIP!" (
        powershell -NoProfile -Command "Expand-Archive -Path '!PLCTAG_ZIP!' -DestinationPath '%TEMP_DIR%\plctag_extract' -Force" 2>nul
        for /r "%TEMP_DIR%\plctag_extract" %%f in (plctag.dll) do (
            copy "%%f" "%FRONTEND_DIR%\plctag.dll" >nul
        )
        rmdir /s /q "%TEMP_DIR%\plctag_extract" 2>nul
        del /q "!PLCTAG_ZIP!" 2>nul
    )
    if not exist "%FRONTEND_DIR%\plctag.dll" (
        echo   ERROR: Failed to download plctag.dll
        pause
        exit /b 1
    )
    echo   Downloaded
)

REM ══════════════════════════════════════════════════════════════
REM  Step 3: Install deps + build (skip if already built)
REM ══════════════════════════════════════════════════════════════
echo [3/6] Installing dependencies...
cd /d "%FRONTEND_DIR%"
call !NPM_CMD! install
if %errorlevel% neq 0 ( echo ERROR: npm install failed & pause & exit /b 1 )

echo [4/6] Building app...
if exist "%FRONTEND_DIR%\dist" rmdir /s /q "%FRONTEND_DIR%\dist"
if exist "%FRONTEND_DIR%\dist-server" rmdir /s /q "%FRONTEND_DIR%\dist-server"
call !NPM_CMD! run build
if %errorlevel% neq 0 ( echo ERROR: Vite build failed & pause & exit /b 1 )
call !NPM_CMD! run build:server
if %errorlevel% neq 0 ( echo ERROR: Server build failed & pause & exit /b 1 )

REM ══════════════════════════════════════════════════════════════
REM  Step 4: Download portable Node.js for distribution
REM ══════════════════════════════════════════════════════════════
echo [5/6] Preparing portable Node.js...
if not exist "%TEMP_DIR%\%NODE_DIR_NAME%\node.exe" (
    echo   Downloading Node.js %NODE_VER%...
    call :DownloadNode
    if !errorlevel! neq 0 exit /b 1
)

REM ══════════════════════════════════════════════════════════════
REM  Step 5: Assemble portable (CLEAN — only what's needed)
REM ══════════════════════════════════════════════════════════════
echo [6/6] Assembling portable distribution...

if exist "%OUTPUT_DIR%" rmdir /s /q "%OUTPUT_DIR%"
mkdir "%OUTPUT_DIR%"

REM ── Node.js runtime ──
echo   Bundling Node.js runtime...
mkdir "%OUTPUT_DIR%\node" 2>nul
copy "%TEMP_DIR%\%NODE_DIR_NAME%\node.exe" "%OUTPUT_DIR%\node\" >nul
copy "%TEMP_DIR%\%NODE_DIR_NAME%\npm.cmd" "%OUTPUT_DIR%\node\" >nul
copy "%TEMP_DIR%\%NODE_DIR_NAME%\npx.cmd" "%OUTPUT_DIR%\node\" >nul
xcopy /E /I /Q /Y "%TEMP_DIR%\%NODE_DIR_NAME%\node_modules" "%OUTPUT_DIR%\node\node_modules"

REM ── Compiled server + Vite output ──
echo   Copying compiled app...
xcopy /E /I /Q /Y "%FRONTEND_DIR%\dist-server" "%OUTPUT_DIR%\app\dist-server"
xcopy /E /I /Q /Y "%FRONTEND_DIR%\dist" "%OUTPUT_DIR%\app\dist-server\dist"

REM ── Startup backup module (plain JS) ──
if not exist "%OUTPUT_DIR%\app\dist-server\lib" mkdir "%OUTPUT_DIR%\app\dist-server\lib"
copy "%FRONTEND_DIR%\lib\startup-backup.js" "%OUTPUT_DIR%\app\dist-server\lib\" >nul 2>nul

REM ── PLC native library ──
copy "%FRONTEND_DIR%\plctag.dll" "%OUTPUT_DIR%\app\" >nul
copy "%FRONTEND_DIR%\plctag.dll" "%OUTPUT_DIR%\app\dist-server\" >nul

REM ── Prisma schema (for seed scripts + @prisma/client) ──
xcopy /E /I /Q /Y "%FRONTEND_DIR%\prisma" "%OUTPUT_DIR%\app\prisma"

REM ── Clean dev artifacts ──
if exist "%OUTPUT_DIR%\app\dist-server\backups" rmdir /s /q "%OUTPUT_DIR%\app\dist-server\backups"
if exist "%OUTPUT_DIR%\app\dist-server\logs" rmdir /s /q "%OUTPUT_DIR%\app\dist-server\logs"
del "%OUTPUT_DIR%\app\dist-server\database.db" 2>nul
del "%OUTPUT_DIR%\app\dist-server\database.db-wal" 2>nul
del "%OUTPUT_DIR%\app\dist-server\database.db-shm" 2>nul

REM ══════════════════════════════════════════════════════════════
REM  PRODUCTION node_modules — only runtime packages
REM ══════════════════════════════════════════════════════════════
echo   Installing production dependencies only...
set "NM_DST=%OUTPUT_DIR%\app\dist-server"

REM Create a minimal package.json with only runtime deps
(
echo {
echo   "name": "io-checkout-runtime",
echo   "private": true,
echo   "dependencies": {
echo     "express": "^5.2.1",
echo     "better-sqlite3": "%SQLITE3_VER%",
echo     "ws": "^8.19.0",
echo     "ffi-rs": "^1.3.1",
echo     "jsonwebtoken": "^9.0.3",
echo     "bcryptjs": "^3.0.3",
echo     "http-proxy": "^1.18.1",
echo     "@prisma/client": "^5.19.0",
echo     "tsconfig-paths": "^4.2.0"
echo   }
echo }
) > "%NM_DST%\package.json.runtime"

REM Save original package.json, swap in runtime-only version
if exist "%NM_DST%\package.json" copy "%NM_DST%\package.json" "%NM_DST%\package.json.bak" >nul
copy "%NM_DST%\package.json.runtime" "%NM_DST%\package.json" >nul

REM Install production deps only into the output folder
pushd "%NM_DST%"
"%OUTPUT_DIR%\node\node.exe" "%OUTPUT_DIR%\node\node_modules\npm\bin\npm-cli.js" install --omit=dev --ignore-scripts 2>nul
popd

REM Restore original package.json
if exist "%NM_DST%\package.json.bak" (
    copy "%NM_DST%\package.json.bak" "%NM_DST%\package.json" >nul
    del "%NM_DST%\package.json.runtime" 2>nul
    del "%NM_DST%\package.json.bak" 2>nul
) else (
    del "%NM_DST%\package.json.runtime" 2>nul
)

REM ── better-sqlite3: download prebuilt native binary for bundled Node ABI ──
echo   Downloading prebuilt better-sqlite3 for Node.js %NODE_VER%...
set "PREBUILT_URL=https://github.com/WiseLibs/better-sqlite3/releases/download/v%SQLITE3_VER%/better-sqlite3-v%SQLITE3_VER%-node-v%NODE_ABI%-win32-x64.tar.gz"
set "PREBUILT_TGZ=%TEMP_DIR%\better-sqlite3-prebuilt.tar.gz"
powershell -NoProfile -Command "& { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%PREBUILT_URL%' -OutFile '%PREBUILT_TGZ%' }" 2>nul
if exist "%PREBUILT_TGZ%" (
    if not exist "%NM_DST%\node_modules\better-sqlite3\build\Release" mkdir "%NM_DST%\node_modules\better-sqlite3\build\Release"
    pushd "%NM_DST%\node_modules\better-sqlite3\build\Release"
    tar -xzf "%PREBUILT_TGZ%" --strip-components=1 2>nul
    popd
    echo   Prebuilt native module installed
) else (
    echo   WARNING: Could not download prebuilt — using npm-installed version
)

REM Verify better-sqlite3 works with bundled Node
"%OUTPUT_DIR%\node\node.exe" -e "require('%NM_DST:\=/%/node_modules/better-sqlite3')" 2>nul
if %errorlevel% neq 0 (
    echo   WARNING: better-sqlite3 ABI mismatch — trying rebuild...
    pushd "%NM_DST%"
    set "npm_config_nodedir=%OUTPUT_DIR%\node"
    set "PATH=%OUTPUT_DIR%\node;%PATH%"
    "%OUTPUT_DIR%\node\node.exe" "%OUTPUT_DIR%\node\node_modules\npm\bin\npm-cli.js" rebuild better-sqlite3 2>nul
    set "npm_config_nodedir="
    popd
)

REM ── Create .env ──
(
echo DATABASE_URL=file:../database.db
echo JWT_SECRET_KEY=io-checkout-%RANDOM%%RANDOM%%RANDOM%
echo PORT=3000
echo HOSTNAME=0.0.0.0
echo NODE_ENV=production
) > "%NM_DST%\.env"

REM ══════════════════════════════════════════════════════════════
REM  Generate START.bat, STATUS.bat, etc.
REM ══════════════════════════════════════════════════════════════

REM ── START.bat ──
(
echo @echo off
echo setlocal
echo set "ROOT=%%~dp0"
echo set "NODE=%%ROOT%%node\node.exe"
echo set "APP=%%ROOT%%app"
echo.
echo REM ── Auto-setup firewall ──
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
echo echo   App:   http://localhost:3000
echo echo.
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
echo echo Server stopped.
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
echo if %%errorlevel%% equ 0 ^(echo   App ^(port 3000^): RUNNING^) else ^(echo   App ^(port 3000^): NOT RUNNING^)
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

REM ── README.txt ──
(
echo IO Checkout Tool - Portable Distribution
echo =========================================
echo.
echo FIRST TIME: Double-click START.bat
echo DAILY USE:  START.bat to launch, close window to stop
echo STATUS:     Run STATUS.bat to check if running
echo.
echo Access: http://localhost:3000 ^(or your IP on tablets^)
echo Port:   3000 ^(app + WebSocket on /ws^)
) > "%OUTPUT_DIR%\README.txt"

REM ── Cleanup ──
if exist "%TEMP_DIR%\better-sqlite3-prebuilt.tar.gz" del "%TEMP_DIR%\better-sqlite3-prebuilt.tar.gz"

echo.
echo ============================================================
echo  BUILD COMPLETE
echo ============================================================
echo.
echo Output: %OUTPUT_DIR%
echo.
echo Copy to any Windows PC and double-click START.bat.
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

echo   Downloading Node.js %NODE_VER%...
powershell -NoProfile -Command "& { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%NODE_ZIP%' }" 2>nul

if not exist "%NODE_ZIP%" (
    echo   ERROR: Failed to download Node.js
    pause
    exit /b 1
)

echo   Extracting Node.js...
powershell -NoProfile -Command "Expand-Archive -Path '%NODE_ZIP%' -DestinationPath '%TEMP_DIR%' -Force" 2>nul
del /q "%NODE_ZIP%" 2>nul

if not exist "%TEMP_DIR%\%NODE_DIR_NAME%\node.exe" (
    echo   ERROR: Node.js extraction failed
    pause
    exit /b 1
)

echo   Node.js %NODE_VER% ready
exit /b 0
