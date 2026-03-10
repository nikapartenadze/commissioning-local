@echo off
echo ============================================================
echo  IO Checkout Tool - Status
echo ============================================================
echo.

echo Checking ports...
echo.

netstat -an | findstr ":3000 " | findstr "LISTENING" >nul 2>nul
if %errorlevel% equ 0 (
    echo   App (port 3000):       RUNNING
) else (
    echo   App (port 3000):       NOT RUNNING
)

netstat -an | findstr ":3001 " | findstr "LISTENING" >nul 2>nul
if %errorlevel% equ 0 (
    echo   WebSocket (port 3001): RUNNING
) else (
    echo   WebSocket (port 3001): NOT RUNNING
)

echo.
echo Node.js processes:
tasklist /fi "IMAGENAME eq node.exe" 2>nul | findstr "node.exe"
if %errorlevel% neq 0 (
    echo   None
)

echo.

REM Show local IP addresses
echo Network addresses (share with technicians):
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do (
    for /f "tokens=1" %%b in ("%%a") do (
        echo   http://%%b:3000
    )
)

echo.
pause
