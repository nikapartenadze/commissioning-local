@echo off
echo Starting IO Checkout Tool Development Environment...
echo.

echo Stopping any existing IO Checkout processes...
taskkill /f /im "IO Checkout Tool.exe" 2>nul
taskkill /f /im "dotnet.exe" 2>nul

echo Cleaning build directories...
if exist "IO-Checkout-Tool copy\bin" rmdir /s /q "IO-Checkout-Tool copy\bin"
if exist "IO-Checkout-Tool copy\obj" rmdir /s /q "IO-Checkout-Tool copy\obj"
if exist "Shared.Library\bin" rmdir /s /q "Shared.Library\bin"
if exist "Shared.Library\obj" rmdir /s /q "Shared.Library\obj"

echo Starting C# Backend...
start "IO Checkout C# Backend" cmd /k "cd /d "%~dp0IO-Checkout-Tool copy" && dotnet run"

echo Waiting 5 seconds for C# backend to start...
timeout /t 5 /nobreak > nul

echo Starting Next.js Frontend...
start "IO Checkout Next.js Frontend" cmd /k "cd /d "%~dp0commissioning-tool-frontend" && npm run dev"

echo.
echo Both applications are starting...
echo C# Backend: http://localhost:5000
echo Next.js Frontend: http://localhost:3000
echo.
echo Press any key to close this window...
pause > nul
