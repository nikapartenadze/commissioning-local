@echo off
setlocal enabledelayedexpansion

echo ============================================================
echo  IO Checkout Tool - Build Portable Distribution
echo ============================================================
echo.

REM Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed. Install from https://nodejs.org
    pause
    exit /b 1
)

set "PROJECT_DIR=%~dp0.."
set "FRONTEND_DIR=%PROJECT_DIR%\frontend"
set "OUTPUT_DIR=%PROJECT_DIR%\portable"

echo [1/5] Cleaning previous build...
if exist "%OUTPUT_DIR%" rmdir /s /q "%OUTPUT_DIR%"
mkdir "%OUTPUT_DIR%"

echo [2/5] Installing dependencies...
cd /d "%FRONTEND_DIR%"
call npm ci --production=false
if %errorlevel% neq 0 (
    echo ERROR: npm ci failed
    pause
    exit /b 1
)

echo [3/5] Generating Prisma client...
call npx prisma generate
if %errorlevel% neq 0 (
    echo ERROR: Prisma generate failed
    pause
    exit /b 1
)

echo [4/5] Building Next.js (standalone)...
call npm run build
if %errorlevel% neq 0 (
    echo ERROR: Build failed
    pause
    exit /b 1
)

echo [5/5] Assembling portable distribution...

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

REM Copy native PLC library (Windows DLL)
if exist "%FRONTEND_DIR%\plctag.dll" (
    copy "%FRONTEND_DIR%\plctag.dll" "%OUTPUT_DIR%\app\"
)

REM Copy Prisma schema and generated client
xcopy /E /I /Q "%FRONTEND_DIR%\prisma" "%OUTPUT_DIR%\app\prisma"
xcopy /E /I /Q "%FRONTEND_DIR%\node_modules\.prisma" "%OUTPUT_DIR%\app\node_modules\.prisma"
xcopy /E /I /Q "%FRONTEND_DIR%\node_modules\@prisma" "%OUTPUT_DIR%\app\node_modules\@prisma"

REM Copy ws module (for WebSocket server)
xcopy /E /I /Q "%FRONTEND_DIR%\node_modules\ws" "%OUTPUT_DIR%\app\node_modules\ws"

REM Copy startup scripts
copy "%~dp0START.bat" "%OUTPUT_DIR%\"
copy "%~dp0STOP.bat" "%OUTPUT_DIR%\"
copy "%~dp0STATUS.bat" "%OUTPUT_DIR%\"

REM Create default .env
(
echo DATABASE_URL=file:./database.db
echo JWT_SECRET_KEY=change-this-in-production
echo PLC_WS_PORT=3001
echo PORT=3000
echo HOSTNAME=0.0.0.0
echo NODE_ENV=production
) > "%OUTPUT_DIR%\app\.env"

echo.
echo ============================================================
echo  BUILD COMPLETE
echo ============================================================
echo.
echo Output: %OUTPUT_DIR%
echo.
echo To deploy:
echo   1. Copy the "portable" folder to the factory server
echo   2. Install Node.js 20+ on the server (https://nodejs.org)
echo   3. Place plctag.dll in the portable\app\ folder
echo   4. Edit portable\app\.env if needed
echo   5. Double-click START.bat
echo   6. Open http://SERVER_IP:3000 on tablets
echo.
pause
