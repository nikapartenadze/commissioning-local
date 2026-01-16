@echo off
title IO Checkout Tool - Installation Wizard
color 0B

echo.
echo ========================================================
echo   IO CHECKOUT TOOL - INSTALLATION WIZARD
echo ========================================================
echo.
echo   This will set up the IO Checkout Tool on this computer.
echo   You will need Administrator access for some steps.
echo.
echo ========================================================
echo.
pause

REM Get script directory
set SCRIPT_DIR=%~dp0

REM Check if running as admin
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo.
    echo WARNING: Not running as Administrator!
    echo Some features (firewall, auto-start) may not work.
    echo.
    echo To run as Administrator:
    echo   1. Right-click INSTALL.bat
    echo   2. Select "Run as administrator"
    echo.
    pause
)

echo.
echo STEP 1: Configuration Setup
echo ---------------------------
echo.

REM Check if config already exists
if exist "%SCRIPT_DIR%backend\config.json" (
    echo Config file already exists.
    set /p RECONFIG="Do you want to reconfigure? (Y/N): "
    if /i not "%RECONFIG%"=="Y" goto :firewall
)

echo.
echo Enter your PLC settings (ask your controls engineer if unsure):
echo.

:get_ip
set /p PLC_IP="PLC IP Address (e.g., 192.168.1.100): "
if "%PLC_IP%"=="" (
    echo IP address cannot be empty!
    goto :get_ip
)

set /p PLC_PATH="PLC Path (usually 1,0 or 1,1): "
if "%PLC_PATH%"=="" set PLC_PATH=1,0

set /p SUBSYSTEM_ID="Subsystem ID (default: 1): "
if "%SUBSYSTEM_ID%"=="" set SUBSYSTEM_ID=1

echo.
echo Creating config.json with:
echo   IP: %PLC_IP%
echo   Path: %PLC_PATH%
echo   Subsystem: %SUBSYSTEM_ID%
echo.

REM Create config.json
(
echo {
echo   "ip": "%PLC_IP%",
echo   "path": "%PLC_PATH%",
echo   "subsystemId": "%SUBSYSTEM_ID%",
echo   "remoteUrl": "",
echo   "ApiPassword": "",
echo   "orderMode": "0",
echo   "disableWatchdog": "false",
echo   "showStateColumn": "true",
echo   "showResultColumn": "true",
echo   "showTimestampColumn": "true",
echo   "showHistoryColumn": "true",
echo   "syncBatchSize": "50",
echo   "syncBatchDelayMs": "500"
echo }
) > "%SCRIPT_DIR%backend\config.json"

echo Config file created successfully!
echo.

:firewall
echo.
echo STEP 2: Firewall Configuration
echo ------------------------------
echo.
echo Opening ports 5000 and 3002 for network access...
echo.

REM Add firewall rules (will fail silently if not admin)
netsh advfirewall firewall delete rule name="IO Checkout Backend" >nul 2>&1
netsh advfirewall firewall delete rule name="IO Checkout Frontend" >nul 2>&1
netsh advfirewall firewall add rule name="IO Checkout Backend" dir=in action=allow protocol=tcp localport=5000 >nul 2>&1
netsh advfirewall firewall add rule name="IO Checkout Frontend" dir=in action=allow protocol=tcp localport=3002 >nul 2>&1

if %errorLevel% equ 0 (
    echo Firewall rules added successfully!
) else (
    echo Could not add firewall rules. You may need to run as Administrator.
)
echo.

:autostart
echo.
echo STEP 3: Auto-Start on Boot (Optional)
echo -------------------------------------
echo.
set /p AUTOSTART="Start automatically when Windows starts? (Y/N): "
if /i not "%AUTOSTART%"=="Y" goto :desktop

REM Create startup shortcut
echo Creating startup shortcut...
set STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
powershell -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%STARTUP_FOLDER%\IO Checkout Tool.lnk'); $s.TargetPath = '%SCRIPT_DIR%START.bat'; $s.WorkingDirectory = '%SCRIPT_DIR%'; $s.WindowStyle = 7; $s.Save()"

if %errorLevel% equ 0 (
    echo Auto-start configured! App will start when Windows boots.
) else (
    echo Could not create startup shortcut.
)
echo.

:desktop
echo.
echo STEP 4: Desktop Shortcut
echo ------------------------
echo.
set /p DESKTOP_SHORTCUT="Create desktop shortcut? (Y/N): "
if /i not "%DESKTOP_SHORTCUT%"=="Y" goto :done

REM Create desktop shortcut
echo Creating desktop shortcut...
set DESKTOP=%USERPROFILE%\Desktop
powershell -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%DESKTOP%\IO Checkout Tool.lnk'); $s.TargetPath = '%SCRIPT_DIR%START.bat'; $s.WorkingDirectory = '%SCRIPT_DIR%'; $s.Description = 'Start IO Checkout Tool'; $s.Save()"

if %errorLevel% equ 0 (
    echo Desktop shortcut created!
) else (
    echo Could not create desktop shortcut.
)
echo.

:done
echo.
echo ========================================================
echo   INSTALLATION COMPLETE!
echo ========================================================
echo.
echo To start the application:
echo   - Double-click START.bat (or desktop shortcut)
echo.
echo To access from other computers:
echo   1. Find this computer's IP address (run: ipconfig)
echo   2. Open browser on tablet/PC to: http://YOUR_IP:3002
echo.
echo Default admin PIN: 852963
echo (Change this after first login!)
echo.
echo ========================================================
echo.

set /p START_NOW="Start the application now? (Y/N): "
if /i "%START_NOW%"=="Y" (
    call "%SCRIPT_DIR%START.bat"
)

pause
