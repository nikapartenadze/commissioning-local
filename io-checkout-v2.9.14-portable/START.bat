@echo off
setlocal
set "ROOT=%~dp0"
set "NODE=%ROOT%node\node.exe"
set "NPX=%ROOT%node\npx.cmd"
set "PATH=%ROOT%node;%PATH%"
set "APP=%ROOT%app"

REM ── Auto-setup firewall rules if not present ──
netsh advfirewall firewall show rule name="IO Checkout - App" >nul 2>&1
if %errorlevel% neq 0 (
    echo Setting up firewall rules...
    net session >nul 2>&1
    if %errorlevel% neq 0 (
        echo Requesting administrator access for firewall setup...
        powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~dp0SETUP-FIREWALL.bat'" 2>nul
    ) else (
        netsh advfirewall firewall add rule name="IO Checkout - App" dir=in action=allow protocol=tcp localport=3000 >nul
        echo Firewall rules added.
    )
)

REM ── Check database ──
if not exist "%APP%\database.db" (
    echo ERROR: database.db is missing. Please re-run BUILD-PORTABLE.bat.
    pause
    exit /b 1
)

echo ============================================================
echo  IO Checkout Tool
echo ============================================================
echo.
echo   App:        http://localhost:3000
echo   Admin PIN:  111111
echo.
REM Show IP addresses
echo   Tablet access:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do (
    for /f "tokens=1" %%b in ("%%a") do (
        echo     http://%%b:3000
    )
)
echo.
echo   Press Ctrl+C to stop.
echo ============================================================

cd /d "%APP%"
"%NODE%" server.js
echo.
echo Server stopped unexpectedly.
pause
