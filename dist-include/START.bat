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
