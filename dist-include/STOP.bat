@echo off
title IO Checkout Tool - Stopper
color 0C

echo ========================================
echo   Stopping IO Checkout Tool...
echo ========================================
echo.

echo Stopping backend...
taskkill /F /IM "IO Checkout Tool.exe" 2>nul
if errorlevel 1 (
    echo Backend was not running.
) else (
    echo Backend stopped.
)

echo.
echo Stopping frontend...
taskkill /F /FI "WINDOWTITLE eq IO-Checkout-Frontend*" 2>nul
taskkill /F /FI "WINDOWTITLE eq IO-Checkout-Backend*" 2>nul
for /f "tokens=2" %%a in ('tasklist ^| findstr /i "node.exe"') do (
    taskkill /F /PID %%a 2>nul
)

echo.
echo ========================================
echo   Application Stopped
echo ========================================
pause
