@echo off
setlocal enabledelayedexpansion
title IO Checkout Tool - Distribution Builder
color 0E

echo ========================================
echo   IO Checkout Tool - Distribution Builder
echo ========================================
echo.

REM Add dotnet and node to PATH if installed in user-local locations
set "PATH=%LOCALAPPDATA%\Microsoft\dotnet;%PATH%"
for /D %%d in ("%LOCALAPPDATA%\nodejs-portable\node-v*") do set "PATH=%%d;!PATH!"
if exist "%LOCALAPPDATA%\nodejs-portable\node.exe" set "PATH=%LOCALAPPDATA%\nodejs-portable;%PATH%"

set "DIST=portable"
set "BACKEND_SRC=backend"
set "FRONTEND_SRC=frontend"

REM Setup build log in TEMP (safe from mid-build folder deletion)
for /f "delims=" %%I in ('powershell -Command "Get-Date -Format yyyy-MM-dd_HH-mm-ss"') do set "DT=%%I"
set "LOG=%TEMP%\io-checkout-build-%DT%.log"
echo Build started: %DATE% %TIME% > "%LOG%"
echo ============================== >> "%LOG%"

REM =============================================
REM  Step 1: Prepare distribution folder
REM =============================================
call :log "[1/6] Preparing distribution folder..."

REM Stop running processes first to release file locks
call :log "Stopping any running instances..."
taskkill /F /IM "IO Checkout Tool.exe" >> "%LOG%" 2>&1
taskkill /F /FI "WINDOWTITLE eq IO-Checkout-Frontend*" >> "%LOG%" 2>&1
taskkill /F /FI "WINDOWTITLE eq IO-Checkout-Backend*" >> "%LOG%" 2>&1
timeout /t 2 /nobreak >nul

REM Preserve node.exe before cleaning (avoid re-downloading every build)
set "SAVED_NODE="
if exist "%DIST%\nodejs\node.exe" (
    call :log "Preserving existing node.exe..."
    copy /Y "%DIST%\nodejs\node.exe" "%TEMP%\node-exe-backup.exe" >nul
    set "SAVED_NODE=%TEMP%\node-exe-backup.exe"
)

REM Preserve old logs before cleaning
if exist "%DIST%\logs" (
    mkdir "%TEMP%\io-checkout-logs-backup" 2>nul
    xcopy /E /Y /Q "%DIST%\logs\*" "%TEMP%\io-checkout-logs-backup\" >nul 2>&1
)

REM Remove old distribution
if exist "%DIST%" (
    call :log "Removing old distribution folder..."
    rmdir /S /Q "%DIST%" 2>nul
    if exist "%DIST%" (
        call :log "Warning: Could not fully remove old distribution. Some files may be locked."
    ) else (
        call :log "Old distribution removed successfully."
    )
)

REM Create directories
mkdir "%DIST%" 2>nul
mkdir "%DIST%\backend" 2>nul
mkdir "%DIST%\frontend" 2>nul
mkdir "%DIST%\nodejs" 2>nul
mkdir "%DIST%\logs" 2>nul

REM Restore previous logs
if exist "%TEMP%\io-checkout-logs-backup" (
    xcopy /E /Y /Q "%TEMP%\io-checkout-logs-backup\*" "%DIST%\logs\" >nul 2>&1
    rmdir /S /Q "%TEMP%\io-checkout-logs-backup" 2>nul
)

REM =============================================
REM  Step 2: Build .NET backend (self-contained)
REM =============================================
echo.
call :log "[2/6] Building .NET backend (self-contained)..."

REM Clean build artifacts to prevent cached path issues
call :log "Cleaning build artifacts..."
rmdir /S /Q "%BACKEND_SRC%\obj" 2>nul
rmdir /S /Q "%BACKEND_SRC%\bin" 2>nul
rmdir /S /Q "Shared.Library\obj" 2>nul
rmdir /S /Q "Shared.Library\bin" 2>nul

pushd "%BACKEND_SRC%"
dotnet restore >> "%LOG%" 2>&1
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=false -o "..\%DIST%\backend" >> "%LOG%" 2>&1
if errorlevel 1 (
    call :log "ERROR: Failed to build backend!"
    popd
    pause
    exit /b 1
)
call :log "Backend build complete."
popd

REM Copy config files
call :log "Copying configuration files..."
copy /Y "%BACKEND_SRC%\config.json.template" "%DIST%\backend\config.json.template" >nul 2>&1
copy /Y "%BACKEND_SRC%\config-help.txt" "%DIST%\backend\config-help.txt" >nul 2>&1

REM =============================================
REM  Step 3: Build Next.js frontend
REM =============================================
echo.
call :log "[3/6] Building Next.js frontend..."
pushd "%FRONTEND_SRC%"

call :log "Installing frontend dependencies..."
call npm install >> "%LOG%" 2>&1
if errorlevel 1 (
    call :log "ERROR: Failed to install frontend dependencies!"
    popd
    pause
    exit /b 1
)

call npm run build >> "%LOG%" 2>&1
if errorlevel 1 (
    call :log "ERROR: Failed to build frontend!"
    popd
    pause
    exit /b 1
)
call :log "Frontend build complete."

REM Copy standalone build
if exist ".next\standalone" (
    call :log "Copying standalone build..."
    xcopy /E /Y /Q ".next\standalone\*" "..\%DIST%\frontend\" >nul
    if exist ".next\static" (
        call :log "Copying static assets..."
        mkdir "..\%DIST%\frontend\.next\static" 2>nul
        xcopy /E /Y /Q ".next\static\*" "..\%DIST%\frontend\.next\static\" >nul
    )
    if exist "public" (
        call :log "Copying public assets..."
        xcopy /E /Y /Q "public" "..\%DIST%\frontend\public\" >nul
    )
) else (
    call :log "WARNING: Standalone build not found. Copying entire .next folder..."
    xcopy /E /Y /Q ".next" "..\%DIST%\frontend\.next\" >nul
    if exist "public" xcopy /E /Y /Q "public" "..\%DIST%\frontend\public\" >nul
)
popd

REM =============================================
REM  Step 4: Node.js portable
REM =============================================
echo.
call :log "[4/6] Setting up Node.js portable..."

if not defined SAVED_NODE goto :node_download
if not exist "!SAVED_NODE!" goto :node_download
call :log "Restoring preserved node.exe (skipping download)..."
copy /Y "!SAVED_NODE!" "%DIST%\nodejs\node.exe" >nul
del /F "!SAVED_NODE!" 2>nul
call :log "Node.js portable restored successfully!"
goto :node_done

:node_download
call :log "No existing node.exe found, downloading..."
set "NODE_VER=20.11.0"
set "NODE_URL=https://nodejs.org/dist/v%NODE_VER%/node-v%NODE_VER%-win-x64.zip"
set "NODE_ZIP=%TEMP%\nodejs-portable.zip"
set "NODE_EXTRACT=%TEMP%\nodejs-extract"

REM Check if zip already downloaded
if exist "%NODE_ZIP%" (
    call :log "Using previously downloaded Node.js zip..."
) else (
    call :log "Downloading Node.js from nodejs.org..."
    powershell -Command "try { Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%NODE_ZIP%' -UseBasicParsing; exit 0 } catch { exit 1 }" >> "%LOG%" 2>&1
    if errorlevel 1 (
        call :log "ERROR: Failed to download Node.js automatically."
        echo Please manually download from:
        echo   https://nodejs.org/dist/v%NODE_VER%/node-v%NODE_VER%-win-x64.zip
        echo Extract node.exe into the %DIST%\nodejs folder.
        goto :node_done
    )
)

call :log "Extracting Node.js..."
if exist "%NODE_EXTRACT%" rmdir /S /Q "%NODE_EXTRACT%" 2>nul
powershell -Command "Expand-Archive -Path '%NODE_ZIP%' -DestinationPath '%NODE_EXTRACT%' -Force" >> "%LOG%" 2>&1

for /D %%d in ("%NODE_EXTRACT%\node-v*-win-x64") do (
    copy /Y "%%d\node.exe" "%DIST%\nodejs\node.exe" >nul
    call :log "Node.js portable included successfully!"
)

REM Cleanup extract folder (keep zip for next build)
rmdir /S /Q "%NODE_EXTRACT%" 2>nul

:node_done

REM =============================================
REM  Step 5: Copy launcher scripts from templates
REM =============================================
echo.
call :log "[5/6] Copying launcher scripts..."
copy /Y "dist-templates\START.bat" "%DIST%\START.bat" >nul
copy /Y "dist-templates\STOP.bat" "%DIST%\STOP.bat" >nul

REM =============================================
REM  Step 6: Create documentation files
REM =============================================
call :log "[6/6] Creating documentation..."

REM --- README.txt ---
(
echo IO CHECKOUT TOOL - PORTABLE VERSION
echo ====================================
echo.
echo STARTING:
echo 1. Double-click START.bat
echo 2. Wait for both servers to start (about 10 seconds^)
echo 3. Browser opens automatically to http://localhost:3002
echo 4. Default admin PIN: 852963
echo.
echo FIRST TIME SETUP:
echo 1. Log in with admin PIN: 852963
echo 2. Click the gear icon in the toolbar to open config
echo 3. Set Remote URL, Subsystem ID, API Password
echo 4. Click "Pull IOs" to fetch data from cloud
echo 5. Create user accounts for electricians via Admin Panel
echo.
echo STOPPING:
echo - Double-click STOP.bat
echo.
echo ACCESS FROM OTHER COMPUTERS:
echo - Find this computer's IP address (run: ipconfig^)
echo - On tablets/other PCs, open browser to: http://THIS_COMPUTER_IP:3002
echo - Example: http://192.168.1.50:3002
echo.
echo MULTIPLE USERS:
echo - Multiple people can test the same subsystem at the same time
echo - All browsers show live updates when someone marks a point passed/failed
echo - Each person should log in with their own PIN
echo.
echo FIREWALL:
echo If other computers cannot connect, run these commands as Administrator:
echo   netsh advfirewall firewall add rule name="IO Checkout Backend" dir=in action=allow protocol=tcp localport=5000
echo   netsh advfirewall firewall add rule name="IO Checkout Frontend" dir=in action=allow protocol=tcp localport=3002
echo.
echo FILES:
echo - backend/                      - Application server
echo - backend/config.json.template  - Configuration template
echo - backend/database.db           - Test data (created automatically^)
echo - frontend/                     - Web interface
echo - nodejs/                       - Node.js runtime
echo - logs/                         - Build logs
echo.
echo TROUBLESHOOTING:
echo - Backend fails: Make sure no other program is using port 5000
echo - Cannot connect to PLC: Check PLC config in the app's config dialog
echo - Other computers cannot access: Check firewall rules above
echo - See config-help.txt in backend folder for configuration details
) > "%DIST%\README.txt"

REM --- FACTORY-SETUP.txt ---
(
echo IO CHECKOUT TOOL - FACTORY SETUP GUIDE
echo =======================================
echo.
echo This guide is for the person setting up the IO Checkout Tool on a factory
echo server or computer. Follow these steps in order.
echo.
echo.
echo STEP 1: COPY FILES TO SERVER
echo -----------------------------
echo Copy the entire portable folder to the server.
echo Recommended location: C:\IOCheckout
echo.
echo Do not rename the internal folders (backend, frontend, nodejs^).
echo.
echo.
echo STEP 2: START THE APPLICATION
echo ------------------------------
echo A. Double-click START.bat
echo B. Wait about 10 seconds for both servers to start
echo C. Browser opens automatically to http://localhost:3002
echo.
echo.
echo STEP 3: CONFIGURE AND PULL DATA
echo ---------------------------------
echo A. Log in with the default admin PIN: 852963
echo B. Click the gear icon in the toolbar
echo C. Enter settings:
echo    - Remote URL: Your cloud server URL
echo    - Subsystem ID: The subsystem to test
echo    - API Password: Your API key
echo D. Click "Pull IOs" to fetch I/O definitions from cloud
echo.
echo.
echo STEP 4: OPEN FIREWALL PORTS
echo ----------------------------
echo Other computers need to connect to ports 5000 and 3002.
echo.
echo A. Open Command Prompt as Administrator
echo    (Right-click Start, select "Terminal (Admin)"^)
echo.
echo B. Run these two commands:
echo    netsh advfirewall firewall add rule name="IO Checkout Backend" dir=in action=allow protocol=tcp localport=5000
echo    netsh advfirewall firewall add rule name="IO Checkout Frontend" dir=in action=allow protocol=tcp localport=3002
echo.
echo.
echo STEP 5: FIND SERVER IP ADDRESS
echo ------------------------------
echo A. Open Command Prompt
echo B. Type: ipconfig
echo C. Look for "IPv4 Address" under your network adapter
echo    Example: 192.168.1.50
echo D. Write this down - electricians will use it
echo.
echo.
echo STEP 6: TEST FROM ANOTHER COMPUTER
echo -----------------------------------
echo A. On a tablet or another PC on the same network
echo B. Open a web browser
echo C. Go to: http://SERVER_IP:3002
echo    Example: http://192.168.1.50:3002
echo D. You should see the login screen
echo.
echo.
echo STEP 7: CREATE USER ACCOUNTS
echo ----------------------------
echo A. Log in as admin (PIN: 852963^)
echo B. Click the user icon in the top right
echo C. Select "Admin Panel"
echo D. Create accounts for each electrician
echo    - Enter their name
echo    - Create a 6-digit PIN for them
echo    - They will use this PIN to log in
echo.
echo.
echo DAILY OPERATION
echo ===============
echo - Server must be running START.bat before electricians can use the system
echo - Electricians open browser and go to http://SERVER_IP:3002
echo - Log in with their PIN
echo - Select project and subsystem to test
echo - Mark points as Passed or Failed
echo - Multiple people can test at the same time - all browsers update live
echo.
echo.
echo STOPPING THE APPLICATION
echo ========================
echo Double-click STOP.bat to shut down both servers.
echo.
echo.
echo COMMON PROBLEMS
echo ===============
echo.
echo Problem: Backend fails to start
echo Solution: Make sure no other program uses port 5000.
echo.
echo Problem: Cannot connect to PLC
echo Solution: Verify PLC is powered on and network cable connected.
echo           Ping the PLC IP from command prompt: ping 192.168.x.x
echo           Check the path value with controls engineer.
echo.
echo Problem: Other computers cannot access the application
echo Solution: Run the firewall commands from Step 4.
echo           Check that server and clients are on same network.
echo.
echo Problem: Application is slow
echo Solution: Close other programs on the server.
echo           Check network connection quality.
echo.
echo Problem: Test results not saving
echo Solution: Check that database.db file is not read-only.
echo           Ensure disk has free space.
) > "%DIST%\FACTORY-SETUP.txt"

REM =============================================
REM  Done - copy log into distribution
REM =============================================
echo.
echo ============================== >> "%LOG%"
echo Build finished: %DATE% %TIME% >> "%LOG%"
copy /Y "%LOG%" "%DIST%\logs\" >nul 2>&1

call :log "========================================"
call :log "  Distribution Created Successfully!"
call :log "========================================"
echo.
echo Location: %DIST%
echo Build log: %DIST%\logs\build-%DT%.log
echo.
echo Run portable\START.bat to launch the application.
echo.
pause
goto :eof

REM =============================================
REM  Logging subroutine - prints to console and appends to log file
REM =============================================
:log
echo %~1
echo [%TIME%] %~1 >> "%LOG%" 2>nul
goto :eof
