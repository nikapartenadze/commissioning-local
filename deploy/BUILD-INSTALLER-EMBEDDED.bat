@echo off
setlocal enabledelayedexpansion

echo ============================================================
echo  Commissioning Tool - Build EMBEDDED (single-process) Installer
echo  ONE Windows service; PLC (libplctag) runs IN-PROCESS.
echo  No separate CommissioningGateway PLC service.
echo ============================================================
echo.
echo  Why this build exists:
echo    The default BUILD-INSTALLER.bat ships the two-service SPLIT
echo    (a CommissioningGateway service owns the PLC on :3200 and the
echo    app runs PLC_MODE=remote). On single-MCM field tablets that
echo    split can leave "Connect to PLC" failing and tag writes dropped
echo    if the gateway service is down / its plctag.dll is quarantined.
echo    This build reverts to the proven single-process embedded topology
echo    via installer.nsi's /DLEGACY_EMBEDDED=1 path. Upgrading with it
echo    unconditionally removes any pre-existing gateway service.
echo.

set "DEPLOY_DIR=%~dp0"
set "PROJECT_DIR=%DEPLOY_DIR%.."
set "PORTABLE_DIR=%PROJECT_DIR%\portable"

REM -- makensis --
set "MAKENSIS="
where makensis >nul 2>nul
if %errorlevel% equ 0 (
    for /f "tokens=*" %%p in ('where makensis') do set "MAKENSIS=%%p"
) else (
    if exist "C:\Program Files (x86)\NSIS\makensis.exe" set "MAKENSIS=C:\Program Files (x86)\NSIS\makensis.exe"
    if exist "C:\Program Files\NSIS\makensis.exe" set "MAKENSIS=C:\Program Files\NSIS\makensis.exe"
)
if not defined MAKENSIS (
    echo ERROR: NSIS not found. Install it with: winget install NSIS.NSIS
    pause
    exit /b 1
)
echo   NSIS found: %MAKENSIS%

REM -- nssm --
set "NSSM_PATH="
where nssm >nul 2>nul
if %errorlevel% equ 0 (
    for /f "tokens=*" %%p in ('where nssm') do set "NSSM_PATH=%%p"
) else (
    if exist "C:\Program Files\NSSM\win64\nssm.exe" set "NSSM_PATH=C:\Program Files\NSSM\win64\nssm.exe"
    if exist "C:\Program Files (x86)\nssm\win64\nssm.exe" set "NSSM_PATH=C:\Program Files (x86)\nssm\win64\nssm.exe"
    if exist "%LOCALAPPDATA%\Microsoft\WinGet\Packages\NSSM.NSSM_Microsoft.Winget.Source_8wekyb3d8bbwe\nssm-2.24-101-g897c7ad\win64\nssm.exe" (
        set "NSSM_PATH=%LOCALAPPDATA%\Microsoft\WinGet\Packages\NSSM.NSSM_Microsoft.Winget.Source_8wekyb3d8bbwe\nssm-2.24-101-g897c7ad\win64\nssm.exe"
    )
)
if not defined NSSM_PATH (
    echo ERROR: NSSM not found. Install it with: winget install NSSM.NSSM
    pause
    exit /b 1
)
echo   NSSM found: %NSSM_PATH%

REM -- Version (default from frontend/package.json, never a stale hardcode) --
if not defined APP_VERSION (
    for /f "usebackq tokens=*" %%v in (`node -p "require('%PROJECT_DIR:\=\\%\\frontend\\package.json').version"`) do set "APP_VERSION=%%v"
)
if not defined APP_VERSION (
    echo ERROR: could not resolve APP_VERSION from frontend\package.json
    pause
    exit /b 1
)
echo   App version: %APP_VERSION%

REM -- Step 1: ALWAYS rebuild portable clean so the Vite version badge + .env
REM    carry this exact APP_VERSION (a stale portable\ would ship the wrong
REM    version). BUILD-PORTABLE.bat wipes and rebuilds dist/ + dist-server/. --
echo.
echo [1/2] Building portable distribution (clean)...
echo.
set "APP_VERSION=%APP_VERSION%"
call "%DEPLOY_DIR%BUILD-PORTABLE.bat"
if %errorlevel% neq 0 (
    echo ERROR: Portable build failed
    pause
    exit /b 1
)

REM -- VC++ redistributable system-wide fallback (optional; app-local
REM    vcruntime140.dll already covers the libplctag os-error-126 case) --
set "VCREDIST=%DEPLOY_DIR%vc_redist.x64.exe"
set "VCREDIST_DEF="
if exist "%VCREDIST%" (
    set "VCREDIST_DEF=/DVCREDIST_PATH=%VCREDIST%"
    echo   VC++ redist bundled as a system-wide fallback.
) else (
    echo   NOTE: vc_redist.x64.exe not present; relying on app-local vcruntime140.dll.
)

REM -- Step 2: compile the EMBEDDED installer via /DLEGACY_EMBEDDED=1 --
echo.
echo [2/2] Compiling EMBEDDED installer (single-process, no gateway)...
echo.

if defined VCREDIST_DEF (
    "%MAKENSIS%" /DAPP_VERSION=%APP_VERSION% "/DPORTABLE_DIR=%PORTABLE_DIR%" "/DNSSM_PATH=%NSSM_PATH%" /DLEGACY_EMBEDDED=1 "!VCREDIST_DEF!" "%DEPLOY_DIR%installer.nsi"
) else (
    "%MAKENSIS%" /DAPP_VERSION=%APP_VERSION% "/DPORTABLE_DIR=%PORTABLE_DIR%" "/DNSSM_PATH=%NSSM_PATH%" /DLEGACY_EMBEDDED=1 "%DEPLOY_DIR%installer.nsi"
)

if %errorlevel% neq 0 (
    echo.
    echo ERROR: NSIS compilation failed
    pause
    exit /b 1
)

echo.
echo ============================================================
echo  EMBEDDED INSTALLER BUILD COMPLETE
echo ============================================================
echo.
echo Output: %PROJECT_DIR%\CommissioningTool-Embedded-Setup-v%APP_VERSION%.exe
echo.
echo This installer:
echo   - Installs to C:\Program Files\CommissioningTool
echo   - Stores data in C:\ProgramData\CommissioningTool
echo   - Creates ONE Windows service (auto-start on boot):
echo       * CommissioningTool - app WITH PLC embedded in-process on :3000
echo   - Removes any pre-existing CommissioningGateway service on upgrade
echo   - Preserves database + config across upgrades
echo.
exit /b 0
