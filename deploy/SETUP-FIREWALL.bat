@echo off
echo ============================================================
echo  IO Checkout Tool - Firewall Setup (Run as Administrator)
echo ============================================================
echo.
echo This opens ports 3000 and 3001 so tablets can connect.
echo.

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: This script must be run as Administrator.
    echo Right-click and select "Run as administrator"
    pause
    exit /b 1
)

echo Adding firewall rules...

netsh advfirewall firewall add rule name="IO Checkout Tool - App" dir=in action=allow protocol=tcp localport=3000 >nul
netsh advfirewall firewall add rule name="IO Checkout Tool - WebSocket" dir=in action=allow protocol=tcp localport=3001 >nul

echo.
echo Firewall rules added:
echo   Port 3000 (App)       - OPEN
echo   Port 3001 (WebSocket) - OPEN
echo.
echo Technicians can now connect from tablets.
echo.
pause
