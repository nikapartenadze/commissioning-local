@echo off
setlocal

echo ============================================================
echo  IO Checkout Tool - Starting...
echo ============================================================

REM Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed.
    echo Download from: https://nodejs.org
    pause
    exit /b 1
)

set "APP_DIR=%~dp0app"

REM Initialize database if it doesn't exist
if not exist "%APP_DIR%\database.db" (
    echo Initializing database...
    cd /d "%APP_DIR%"
    call npx prisma db push --skip-generate 2>nul
)

echo Starting IO Checkout Tool...
echo.
echo   App URL:       http://localhost:3000
echo   WebSocket:     ws://localhost:3001
echo   Default PIN:   852963
echo.
echo   Technicians connect from tablets at:
echo   http://THIS_PC_IP:3000
echo.
echo   Press Ctrl+C to stop.
echo ============================================================

cd /d "%APP_DIR%"
node server.js
