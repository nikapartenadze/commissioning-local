@echo off
echo Stopping IO Checkout Tool...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3000 " ^| findstr "LISTENING"') do (
    taskkill /F /PID %%p >nul 2>&1
    echo   Stopped (PID %%p)
)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3102 " ^| findstr "LISTENING"') do (
    taskkill /F /PID %%p >nul 2>&1
)
echo Done.
pause
