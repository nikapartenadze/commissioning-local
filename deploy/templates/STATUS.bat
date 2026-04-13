@echo off
echo ============================================================
echo  IO Checkout Tool - Status
echo ============================================================
echo.
netstat -an | findstr ":3000 " | findstr "LISTENING" >nul 2>nul
if %errorlevel% equ 0 (echo   App (port 3000): RUNNING) else (echo   App (port 3000): NOT RUNNING)
echo.
echo Tablet access URLs:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do (
    for /f "tokens=1" %%b in ("%%a") do (
        echo   http://%%b:3000
    )
)
echo.
pause
