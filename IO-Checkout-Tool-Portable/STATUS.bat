@echo off
title IO Checkout Tool - Status Check
color 0E

echo.
echo ========================================================
echo   IO CHECKOUT TOOL - STATUS CHECK
echo ========================================================
echo.

REM Check backend
echo Checking backend (port 5000)...
tasklist /FI "IMAGENAME eq IO Checkout Tool.exe" 2>NUL | find /I "IO Checkout Tool.exe" >NUL
if %errorLevel% equ 0 (
    echo   [RUNNING] Backend process is running
    netstat -an | find ":5000" | find "LISTENING" >NUL
    if %errorLevel% equ 0 (
        echo   [OK] Port 5000 is listening
    ) else (
        echo   [WARNING] Port 5000 not listening yet (may still be starting)
    )
) else (
    echo   [STOPPED] Backend is NOT running
)

echo.

REM Check frontend
echo Checking frontend (port 3002)...
netstat -an | find ":3002" | find "LISTENING" >NUL
if %errorLevel% equ 0 (
    echo   [RUNNING] Frontend is running on port 3002
) else (
    echo   [STOPPED] Frontend is NOT running
)

echo.

REM Check config
echo Checking configuration...
if exist "%~dp0backend\config.json" (
    echo   [OK] config.json exists
) else (
    echo   [MISSING] config.json not found - run INSTALL.bat first!
)

echo.

REM Get IP addresses
echo Network Information:
echo -------------------
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| find "IPv4"') do (
    set IP=%%a
    echo   Server IP: %IP:~1%
)

echo.
echo Access URLs:
echo   Local:   http://localhost:3002
echo   Network: http://YOUR_IP:3002
echo.
echo ========================================================
echo.

pause
