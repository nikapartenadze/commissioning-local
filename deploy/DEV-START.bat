@echo off
chcp 65001 >nul
title IO Checkout Tool - Development Mode
color 0B

echo.
echo  ╔═══════════════════════════════════════════════════════════════╗
echo  ║           IO CHECKOUT TOOL - DEVELOPMENT MODE                 ║
echo  ╚═══════════════════════════════════════════════════════════════╝
echo.
echo  This will start both backend and frontend in development mode.
echo  Hot-reload enabled for frontend changes.
echo.

set SCRIPT_DIR=%~dp0
set ROOT_DIR=%SCRIPT_DIR%..

:: Get local IP
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    for /f "tokens=1" %%b in ("%%a") do set LOCAL_IP=%%b
)

echo  [1/2] Starting C# Backend (dotnet run)...
start "IO-Backend-Dev" cmd /k "cd /d "%ROOT_DIR%\IO-Checkout-Tool copy" && dotnet run"

timeout /t 5 /nobreak >nul

echo  [2/2] Starting Next.js Frontend (npm run dev)...
start "IO-Frontend-Dev" cmd /k "cd /d "%ROOT_DIR%\commissioning-tool-frontend" && npm run dev"

timeout /t 3 /nobreak >nul

echo.
echo  ╔═══════════════════════════════════════════════════════════════╗
echo  ║              DEVELOPMENT SERVERS STARTING                     ║
echo  ╠═══════════════════════════════════════════════════════════════╣
echo  ║                                                               ║
echo  ║  Backend:   http://localhost:5000                             ║
echo  ║  Frontend:  http://localhost:3000                             ║
echo  ║                                                               ║
echo  ║  Network:   http://%LOCAL_IP%:3000                            ║
echo  ║                                                               ║
echo  ║  Press Ctrl+C in each window to stop.                         ║
echo  ║                                                               ║
echo  ╚═══════════════════════════════════════════════════════════════╝
echo.

timeout /t 3 /nobreak >nul
start http://localhost:3000

echo  Press any key to close this window...
pause >nul
