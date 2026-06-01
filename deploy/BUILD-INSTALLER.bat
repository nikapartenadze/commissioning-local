@echo off
setlocal enabledelayedexpansion

echo ============================================================
echo  Commissioning Tool - Build Windows Installer
echo  Creates a setup .exe with NSSM service integration
echo ============================================================
echo.

set "DEPLOY_DIR=%~dp0"
set "PROJECT_DIR=%DEPLOY_DIR%.."
set "PORTABLE_DIR=%PROJECT_DIR%\portable"

REM ── Check prerequisites ──
set "MAKENSIS="
where makensis >nul 2>nul
if %errorlevel% equ 0 (
    for /f "tokens=*" %%p in ('where makensis') do set "MAKENSIS=%%p"
) else (
    if exist "C:\Program Files (x86)\NSIS\makensis.exe" (
        set "MAKENSIS=C:\Program Files (x86)\NSIS\makensis.exe"
    ) else if exist "C:\Program Files\NSIS\makensis.exe" (
        set "MAKENSIS=C:\Program Files\NSIS\makensis.exe"
    )
)
if not defined MAKENSIS (
    echo ERROR: NSIS not found. Install it with: winget install NSIS.NSIS
    pause
    exit /b 1
)
echo   NSIS found: %MAKENSIS%

REM ── Find NSSM ──
set "NSSM_PATH="
where nssm >nul 2>nul
if %errorlevel% equ 0 (
    for /f "tokens=*" %%p in ('where nssm') do set "NSSM_PATH=%%p"
) else (
    REM Check common locations
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

REM ── Get version ──
if not defined APP_VERSION set "APP_VERSION=2.39.7"
echo   App version: %APP_VERSION%

REM ── Step 1: Build portable distribution first ──
echo.
echo [1/2] Building portable distribution...
echo.
if not exist "%PORTABLE_DIR%\app\dist-server\server-express.js" (
    set "APP_VERSION=%APP_VERSION%"
    call "%DEPLOY_DIR%BUILD-PORTABLE.bat"
    if %errorlevel% neq 0 (
        echo ERROR: Portable build failed
        pause
        exit /b 1
    )
) else (
    echo   Portable build already exists, skipping. Delete portable\ to force rebuild.
)

REM ── Ensure VC++ redistributable is available to bundle (best-effort fallback) ──
REM  The PRIMARY fix for the libplctag "os error 126" failures is the app-local
REM  vcruntime140.dll that BUILD-PORTABLE.bat drops next to node.exe. This redist
REM  is an EXTRA: the installer registers the VC++ runtime system-wide if it's
REM  missing. If the download fails, the installer still builds and the app-local
REM  DLL covers the load error on its own.
set "VCREDIST=%DEPLOY_DIR%vc_redist.x64.exe"
if not exist "%VCREDIST%" (
    echo   Downloading vc_redist.x64.exe ^(VC++ 2015-2022 x64^)...
    curl -sL -o "%VCREDIST%" "https://aka.ms/vs/17/release/vc_redist.x64.exe"
)
set "VCREDIST_DEF="
if exist "%VCREDIST%" (
    set "VCREDIST_DEF=/DVCREDIST_PATH=%VCREDIST%"
    echo   VC++ redist bundled as a system-wide fallback.
) else (
    echo   WARNING: vc_redist.x64.exe not bundled ^(download failed^); relying on app-local vcruntime140.dll.
)

REM ── Step 2: Compile NSIS installer ──
echo.
echo [2/2] Compiling installer...
echo.

if defined VCREDIST_DEF (
    "%MAKENSIS%" /DAPP_VERSION=%APP_VERSION% "/DPORTABLE_DIR=%PORTABLE_DIR%" "/DNSSM_PATH=%NSSM_PATH%" "!VCREDIST_DEF!" "%DEPLOY_DIR%installer.nsi"
) else (
    "%MAKENSIS%" /DAPP_VERSION=%APP_VERSION% "/DPORTABLE_DIR=%PORTABLE_DIR%" "/DNSSM_PATH=%NSSM_PATH%" "%DEPLOY_DIR%installer.nsi"
)

if %errorlevel% neq 0 (
    echo.
    echo ERROR: NSIS compilation failed
    pause
    exit /b 1
)

echo.
echo ============================================================
echo  INSTALLER BUILD COMPLETE
echo ============================================================
echo.
echo Output: %PROJECT_DIR%\CommissioningTool-Setup-v%APP_VERSION%.exe
echo.
echo This installer:
echo   - Installs to C:\Program Files\CommissioningTool
echo   - Stores data in C:\ProgramData\CommissioningTool
echo   - Creates Windows service (auto-start on boot)
echo   - Sets up firewall rules
echo   - Upgrades in-place (preserves database + config)
echo.
pause
exit /b 0
