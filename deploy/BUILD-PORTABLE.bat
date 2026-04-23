@echo off
setlocal enabledelayedexpansion

echo ============================================================
echo  Commissioning Tool - Build Portable Distribution
echo ============================================================
echo.

set "PROJECT_DIR=%~dp0.."
set "FRONTEND_DIR=%PROJECT_DIR%\frontend"
set "OUTPUT_DIR=%PROJECT_DIR%\portable"
if not defined APP_VERSION set "APP_VERSION=1.0.0"

set "PLCTAG_VER=v2.6.15"
set "PLCTAG_URL=https://github.com/libplctag/libplctag/releases/download/%PLCTAG_VER%/libplctag_%PLCTAG_VER:~1%_windows_x64.zip"

REM ══════════════════════════════════════════════════════════════
REM  Step 1: Verify Node.js
REM ══════════════════════════════════════════════════════════════
echo [1/5] Checking Node.js...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo   ERROR: Node.js is not installed on this build machine.
    echo   Install from https://nodejs.org then re-run this script.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do set "NODE_VER=%%v"
echo   Node.js %NODE_VER%

REM ══════════════════════════════════════════════════════════════
REM  Step 2: Download plctag.dll if missing
REM ══════════════════════════════════════════════════════════════
echo [2/5] Checking plctag.dll...
if exist "%FRONTEND_DIR%\plctag.dll" (
    echo   Found
) else (
    echo   Downloading...
    set "TEMP_DIR=%PROJECT_DIR%\temp_build"
    if not exist "!TEMP_DIR!" mkdir "!TEMP_DIR!"
    set "PLCTAG_ZIP=!TEMP_DIR!\libplctag.zip"
    curl -sL -o "!PLCTAG_ZIP!" "%PLCTAG_URL%"
    if exist "!PLCTAG_ZIP!" (
        powershell -NoProfile -Command "Expand-Archive -Path '!PLCTAG_ZIP!' -DestinationPath '!TEMP_DIR!\plctag_extract' -Force" 2>nul
        for /r "!TEMP_DIR!\plctag_extract" %%f in (plctag.dll) do (
            copy "%%f" "%FRONTEND_DIR%\plctag.dll" >nul
        )
        rmdir /s /q "!TEMP_DIR!\plctag_extract" 2>nul
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

REM ── Bundle node.exe from this machine (same binary = ABI match) ──
echo   Bundling node.exe %NODE_VER%...
for /f "tokens=*" %%p in ('where node') do set "NODE_EXE=%%p"
copy "!NODE_EXE!" "%OUTPUT_DIR%\node.exe" >nul

REM ── Compiled server + Vite output ──
echo   Copying compiled app...
xcopy /E /I /Q /Y "%FRONTEND_DIR%\dist-server" "%OUTPUT_DIR%\app\dist-server"
xcopy /E /I /Q /Y "%FRONTEND_DIR%\dist" "%OUTPUT_DIR%\app\dist-server\dist"

REM ── Startup backup module (plain JS) ──
if not exist "%OUTPUT_DIR%\app\dist-server\lib" mkdir "%OUTPUT_DIR%\app\dist-server\lib"
copy "%FRONTEND_DIR%\lib\startup-backup.js" "%OUTPUT_DIR%\app\dist-server\lib\" >nul 2>nul
if not exist "%OUTPUT_DIR%\app\dist-server\tools" mkdir "%OUTPUT_DIR%\app\dist-server\tools"
copy "%FRONTEND_DIR%\tools\install-update.ps1" "%OUTPUT_DIR%\app\dist-server\tools\" >nul 2>nul

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
REM  Production node_modules — native modules match bundled node
REM ══════════════════════════════════════════════════════════════
echo   Installing production dependencies...
set "NM_DST=%OUTPUT_DIR%\app\dist-server"

(
echo {
echo   "name": "commissioning-tool-runtime",
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

if exist "%NM_DST%\package.json" copy "%NM_DST%\package.json" "%NM_DST%\package.json.bak" >nul
copy "%NM_DST%\package.json.runtime" "%NM_DST%\package.json" >nul

pushd "%NM_DST%"
call npm install --omit=dev
popd

if exist "%NM_DST%\package.json.bak" (
    copy "%NM_DST%\package.json.bak" "%NM_DST%\package.json" >nul
    del "%NM_DST%\package.json.runtime" 2>nul
    del "%NM_DST%\package.json.bak" 2>nul
) else (
    del "%NM_DST%\package.json.runtime" 2>nul
)

REM Verify native modules work with bundled node
"%OUTPUT_DIR%\node.exe" -e "require('%NM_DST:\=/%/node_modules/better-sqlite3')" 2>nul
if %errorlevel% neq 0 (
    echo   ERROR: better-sqlite3 does not load with bundled node.exe
    pause
    exit /b 1
)
echo   Native modules verified

REM ── Create .env ──
(
echo DATABASE_URL=file:../database.db
echo JWT_SECRET_KEY=commissioning-tool-%RANDOM%%RANDOM%%RANDOM%
echo PORT=3000
echo HOSTNAME=0.0.0.0
echo NODE_ENV=production
echo APP_VERSION=%APP_VERSION%
echo UPDATE_MANIFEST_URL=
) > "%NM_DST%\.env"

REM ══════════════════════════════════════════════════════════════
REM  Generate scripts
REM ══════════════════════════════════════════════════════════════

REM ── Generate START.bat, STOP.bat, STATUS.bat via Node.js (CRLF guaranteed) ──
node "%~dp0write-bat-files.js" "%OUTPUT_DIR%"

REM ── SETUP-FIREWALL.bat ──
copy "%~dp0SETUP-FIREWALL.bat" "%OUTPUT_DIR%\" >nul

REM ── README.txt ──
(
echo Commissioning Tool
echo ==================
echo.
echo FIRST TIME:  Double-click START.bat
echo DAILY USE:   START.bat to launch, Ctrl+C to stop
echo STATUS:      Run STATUS.bat to check if running
echo.
echo No installation needed. Just extract and run START.bat.
echo.
echo Access: http://localhost:3000 ^(or your IP on tablets^)
) > "%OUTPUT_DIR%\README.txt"

REM ── Show final size ──
set "TOTAL_SIZE=0"
for /f "tokens=3" %%s in ('dir /s "%OUTPUT_DIR%" ^| findstr "File(s)"') do set "TOTAL_SIZE=%%s"

echo.
echo ============================================================
echo  BUILD COMPLETE
echo ============================================================
echo.
echo Output:  %OUTPUT_DIR%
echo Node.js: %NODE_VER%
echo.
echo No setup needed on target PC. Extract and run START.bat.
echo.
pause
exit /b 0
