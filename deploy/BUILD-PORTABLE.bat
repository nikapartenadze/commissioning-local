@echo off
setlocal enabledelayedexpansion

echo ============================================================
echo  IO Checkout Tool - Build Portable Distribution
echo ============================================================
echo.
echo  Requires: Node.js installed on the target PC
echo  Download: https://nodejs.org (any recent version)
echo.

set "PROJECT_DIR=%~dp0.."
set "FRONTEND_DIR=%PROJECT_DIR%\frontend"
set "OUTPUT_DIR=%PROJECT_DIR%\portable"
set "TEMP_DIR=%PROJECT_DIR%\temp_build"

set "PLCTAG_VER=v2.6.15"
set "PLCTAG_URL=https://github.com/libplctag/libplctag/releases/download/%PLCTAG_VER%/libplctag_%PLCTAG_VER:~1%_windows_x64.zip"

REM ══════════════════════════════════════════════════════════════
REM  Step 1: Verify Node.js available for building
REM ══════════════════════════════════════════════════════════════
echo [1/5] Checking Node.js...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo.
    echo   ERROR: Node.js is not installed.
    echo   Download from https://nodejs.org and install it first.
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do set "NODE_VER=%%v"
echo   Node.js %NODE_VER%

REM ══════════════════════════════════════════════════════════════
REM  Step 2: Download plctag.dll if missing
REM ══════════════════════════════════════════════════════════════
echo [2/5] Checking plctag.dll...
if not exist "%TEMP_DIR%" mkdir "%TEMP_DIR%"
if exist "%FRONTEND_DIR%\plctag.dll" (
    echo   Found
) else (
    echo   Downloading...
    set "PLCTAG_ZIP=%TEMP_DIR%\libplctag.zip"
    curl -sL -o "!PLCTAG_ZIP!" "%PLCTAG_URL%"
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
REM  Step 3: Install deps + build
REM ══════════════════════════════════════════════════════════════
echo [3/5] Installing dependencies...
cd /d "%FRONTEND_DIR%"
call npm install
if %errorlevel% neq 0 ( echo ERROR: npm install failed & pause & exit /b 1 )

echo [4/5] Building app...
if exist "%FRONTEND_DIR%\dist" rmdir /s /q "%FRONTEND_DIR%\dist"
if exist "%FRONTEND_DIR%\dist-server" rmdir /s /q "%FRONTEND_DIR%\dist-server"
call npm run build
if %errorlevel% neq 0 ( echo ERROR: Vite build failed & pause & exit /b 1 )
call npm run build:server
if %errorlevel% neq 0 ( echo ERROR: Server build failed & pause & exit /b 1 )

REM ══════════════════════════════════════════════════════════════
REM  Step 5: Assemble portable
REM ══════════════════════════════════════════════════════════════
echo [5/5] Assembling portable distribution...

if exist "%OUTPUT_DIR%" rmdir /s /q "%OUTPUT_DIR%"
mkdir "%OUTPUT_DIR%"
mkdir "%OUTPUT_DIR%\app"

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

REM ── Clean dev artifacts ──
if exist "%OUTPUT_DIR%\app\dist-server\backups" rmdir /s /q "%OUTPUT_DIR%\app\dist-server\backups"
if exist "%OUTPUT_DIR%\app\dist-server\logs" rmdir /s /q "%OUTPUT_DIR%\app\dist-server\logs"
del "%OUTPUT_DIR%\app\dist-server\database.db" 2>nul
del "%OUTPUT_DIR%\app\dist-server\database.db-wal" 2>nul
del "%OUTPUT_DIR%\app\dist-server\database.db-shm" 2>nul

REM ══════════════════════════════════════════════════════════════
REM  Production node_modules — native modules compiled for
REM  whatever Node.js version is installed (no ABI mismatch)
REM ══════════════════════════════════════════════════════════════
echo   Installing production dependencies...
set "NM_DST=%OUTPUT_DIR%\app\dist-server"

REM Create a minimal package.json with only runtime deps
(
echo {
echo   "name": "io-checkout-runtime",
echo   "private": true,
echo   "dependencies": {
echo     "express": "^5.2.1",
echo     "better-sqlite3": "^12.0.0",
echo     "ws": "^8.19.0",
echo     "ffi-rs": "^1.3.1",
echo     "jsonwebtoken": "^9.0.3",
echo     "bcryptjs": "^3.0.3",
echo     "http-proxy": "^1.18.1",
echo     "tsconfig-paths": "^4.2.0"
echo   }
echo }
) > "%NM_DST%\package.json.runtime"

REM Save original, swap in runtime-only version
if exist "%NM_DST%\package.json" copy "%NM_DST%\package.json" "%NM_DST%\package.json.bak" >nul
copy "%NM_DST%\package.json.runtime" "%NM_DST%\package.json" >nul

REM npm install compiles native modules for the current Node.js
pushd "%NM_DST%"
call npm install --omit=dev
popd

REM Restore original package.json
if exist "%NM_DST%\package.json.bak" (
    copy "%NM_DST%\package.json.bak" "%NM_DST%\package.json" >nul
    del "%NM_DST%\package.json.runtime" 2>nul
    del "%NM_DST%\package.json.bak" 2>nul
) else (
    del "%NM_DST%\package.json.runtime" 2>nul
)

REM Verify better-sqlite3 works
node -e "require('%NM_DST:\=/%/node_modules/better-sqlite3')" 2>nul
if %errorlevel% neq 0 (
    echo   ERROR: better-sqlite3 failed to load. Run SETUP.bat on the target PC to fix.
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
REM  Generate scripts
REM ══════════════════════════════════════════════════════════════

REM ── START.bat ──
(
echo @echo off
echo setlocal
echo set "ROOT=%%~dp0"
echo set "APP=%%ROOT%%app"
echo.
echo REM ── Check Node.js ──
echo where node ^>nul 2^>^&1
echo if %%errorlevel%% neq 0 ^(
echo     echo ERROR: Node.js is not installed.
echo     echo Download from https://nodejs.org and install it first.
echo     echo Then run SETUP.bat, then START.bat.
echo     pause
echo     exit /b 1
echo ^)
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
echo node --max-old-space-size=256 --optimize-for-size dist-server\server-express.js
echo echo.
echo echo Server stopped.
echo pause
) > "%OUTPUT_DIR%\START.bat"

REM ── SETUP.bat — Run once on new PC to compile native modules ──
(
echo @echo off
echo setlocal
echo echo ============================================================
echo echo  IO Checkout Tool - First-Time Setup
echo echo ============================================================
echo echo.
echo.
echo where node ^>nul 2^>^&1
echo if %%errorlevel%% neq 0 ^(
echo     echo ERROR: Node.js is not installed.
echo     echo Download from https://nodejs.org and install it first.
echo     pause
echo     exit /b 1
echo ^)
echo.
echo for /f "tokens=*" %%%%v in ^('node --version'^) do echo   Node.js: %%%%v
echo echo.
echo.
echo echo [1/2] Installing native modules for this PC...
echo cd /d "%%~dp0app\dist-server"
echo call npm install --omit=dev
echo if %%errorlevel%% neq 0 ^(
echo     echo ERROR: npm install failed.
echo     pause
echo     exit /b 1
echo ^)
echo echo.
echo.
echo echo [2/2] Setting up firewall...
echo netsh advfirewall firewall show rule name="IO Checkout - App" ^>nul 2^>^&1
echo if %%errorlevel%% neq 0 ^(
echo     net session ^>nul 2^>^&1
echo     if %%errorlevel%% neq 0 ^(
echo         powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%%~dp0SETUP-FIREWALL.bat'" 2^>nul
echo     ^) else ^(
echo         netsh advfirewall firewall add rule name="IO Checkout - App" dir=in action=allow protocol=tcp localport=3000 ^>nul
echo     ^)
echo     echo   Firewall rule added.
echo ^) else ^(
echo     echo   Firewall already configured.
echo ^)
echo echo.
echo.
echo echo ============================================================
echo echo  Setup complete! Run START.bat to launch.
echo echo ============================================================
echo echo.
echo pause
) > "%OUTPUT_DIR%\SETUP.bat"

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
echo IO Checkout Tool
echo ================
echo.
echo PREREQUISITES:
echo   Install Node.js from https://nodejs.org ^(any recent version^)
echo.
echo FIRST TIME ON A NEW PC:
echo   1. Install Node.js
echo   2. Double-click SETUP.bat  ^(compiles native modules + firewall^)
echo   3. Double-click START.bat
echo.
echo DAILY USE:
echo   START.bat    - Launch the app
echo   STATUS.bat   - Check if running + show tablet URLs
echo   Ctrl+C       - Stop the app
echo.
echo UPDATING:
echo   1. Stop the app ^(Ctrl+C^)
echo   2. Replace the app\ folder with the new version
echo   3. Run SETUP.bat again ^(recompiles native modules^)
echo   4. Run START.bat
echo.
echo Access: http://localhost:3000 ^(or your IP on tablets^)
echo Port:   3000 ^(app + WebSocket on /ws^)
) > "%OUTPUT_DIR%\README.txt"

echo.
echo ============================================================
echo  BUILD COMPLETE
echo ============================================================
echo.
echo Output: %OUTPUT_DIR%
echo.
echo Deployment steps:
echo   1. Install Node.js on factory PC ^(https://nodejs.org^)
echo   2. Copy the portable\ folder to the PC
echo   3. Run SETUP.bat once ^(compiles native modules^)
echo   4. Run START.bat to launch
echo.
echo Tablets just open http://^<PC-IP^>:3000 in their browser.
echo.
pause
exit /b 0
