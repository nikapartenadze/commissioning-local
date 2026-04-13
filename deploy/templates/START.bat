@echo off
setlocal
set "ROOT=%~dp0"
set "NODE=%ROOT%node.exe"
set "APP=%ROOT%app"

if not exist "%NODE%" (
    echo ERROR: node.exe not found. Re-extract the portable folder.
    pause
    exit /b 1
)

REM Kill orphaned process on port 3000
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3000 " ^| findstr "LISTENING"') do (
    echo Stopping previous instance (PID %%p)...
    taskkill /F /PID %%p >nul 2>&1
)

REM Auto-setup firewall
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

echo ============================================================
echo  IO Checkout Tool
echo ============================================================
echo.
echo   App:   http://localhost:3000
echo.
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
"%NODE%" --max-old-space-size=256 --optimize-for-size dist-server\server-express.js
echo.
echo Server stopped.
pause
