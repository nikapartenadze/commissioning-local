@echo off
echo Starting IO Checkout Tool Development Environment...
echo.

REM Hardcoded ports (must match frontend/lib/api-config.ts)
set BACKEND_PORT=5000
set FRONTEND_PORT=3002

echo Stopping any existing IO Checkout processes...
taskkill /f /im "IO Checkout Tool.exe" 2>nul
taskkill /f /im "dotnet.exe" 2>nul

echo Cleaning build directories...
if exist "backend\bin" rmdir /s /q "backend\bin"
if exist "backend\obj" rmdir /s /q "backend\obj"
if exist "Shared.Library\bin" rmdir /s /q "Shared.Library\bin"
if exist "Shared.Library\obj" rmdir /s /q "Shared.Library\obj"

echo Starting C# Backend on port %BACKEND_PORT%...
start "IO Checkout C# Backend" cmd /k "cd /d "%~dp0backend" && dotnet run"

echo Waiting 5 seconds for C# backend to start...
timeout /t 5 /nobreak > nul

echo Starting Next.js Frontend on port %FRONTEND_PORT%...
start "IO Checkout Next.js Frontend" cmd /k "cd /d "%~dp0frontend" && set PORT=%FRONTEND_PORT% && npm run dev"

echo.
echo Both applications are starting...
echo C# Backend: http://localhost:%BACKEND_PORT%
echo Next.js Frontend: http://localhost:%FRONTEND_PORT%
echo.
echo Press any key to close this window...
pause > nul
