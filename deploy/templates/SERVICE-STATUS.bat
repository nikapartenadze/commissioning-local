@echo off
REM Quick service diagnostic — run as administrator if you want to start/stop.
REM Bundled with the installer at C:\Program Files\CommissioningTool\.
setlocal

set "SERVICE_NAME=CommissioningTool"
set "INSTDIR=%~dp0"
set "DATA_DIR=%ProgramData%\CommissioningTool"

echo ============================================================
echo  Commissioning Tool - Service Status
echo ============================================================
echo.

echo [Service registration]
sc.exe queryex %SERVICE_NAME% 2>nul
if errorlevel 1 (
    echo   NOT INSTALLED — installer never ran or service was removed
    echo.
    goto end
)
echo.

echo [Service config]
sc.exe qc %SERVICE_NAME%
echo.

echo [Failure recovery]
sc.exe qfailure %SERVICE_NAME%
echo.

echo [Listening on port 3000?]
netstat -ano ^| findstr ":3000 " ^| findstr LISTENING
echo.

echo [Recent service.log lines]
if exist "%DATA_DIR%\logs\service.log" (
    powershell -NoProfile -Command "Get-Content '%DATA_DIR%\logs\service.log' -Tail 25"
) else (
    echo   No service.log yet.
)
echo.

echo [Recent service-error.log lines]
if exist "%DATA_DIR%\logs\service-error.log" (
    powershell -NoProfile -Command "Get-Content '%DATA_DIR%\logs\service-error.log' -Tail 25"
) else (
    echo   No service-error.log yet.
)

:end
echo.
echo ============================================================
echo Quick commands:
echo   Start:    sc start %SERVICE_NAME%        (admin)
echo   Stop:     sc stop %SERVICE_NAME%         (admin)
echo   Restart:  sc stop %SERVICE_NAME% ^&^& sc start %SERVICE_NAME%  (admin)
echo   Logs:     %DATA_DIR%\logs\
echo ============================================================
echo.
pause
