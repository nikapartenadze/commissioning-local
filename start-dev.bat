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
REM Use PowerShell to spawn process - avoids Quick Edit Mode freezing issue
powershell -Command "Start-Process cmd -ArgumentList '/c cd /d \"%~dp0backend\" && dotnet run' -WindowStyle Normal"

echo Waiting 5 seconds for C# backend to start...
timeout /t 5 /nobreak > nul

echo Starting Next.js Frontend on port %FRONTEND_PORT%...
powershell -Command "Start-Process cmd -ArgumentList '/c cd /d \"%~dp0frontend\" && set PORT=%FRONTEND_PORT% && npm run dev' -WindowStyle Normal"

echo.
echo Both applications are starting...
echo C# Backend: http://localhost:%BACKEND_PORT%
echo Next.js Frontend: http://localhost:%FRONTEND_PORT%
echo.
echo TIP: If terminals freeze, click in them and press Enter.
echo      This happens when Quick Edit Mode is enabled in Windows.
echo      To disable: Right-click title bar ^> Properties ^> uncheck Quick Edit Mode
echo.
pause
