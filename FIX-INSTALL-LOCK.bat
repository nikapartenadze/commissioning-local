@echo off
REM ============================================================================
REM  Clears a stuck CommissioningTool / CommissioningGateway install lock
REM  ("error opening node.exe" / "cannot write to node.exe" during setup).
REM
REM  RIGHT-CLICK this file -> "Run as administrator", then re-run the installer.
REM  It only removes the program-files binaries; your data/config in
REM  C:\ProgramData\CommissioningTool is left completely untouched.
REM ============================================================================
setlocal
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo   This must run elevated. Right-click FIX-INSTALL-LOCK.bat
  echo   and choose "Run as administrator".
  echo.
  pause
  exit /b 1
)

set "INSTDIR=%ProgramFiles%\CommissioningTool"

echo [1/5] Stopping services...
sc stop CommissioningTool        >nul 2>&1
sc stop CommissioningGateway     >nul 2>&1
timeout /t 4 /nobreak >nul

echo [2/5] Removing services...
if exist "%INSTDIR%\nssm.exe" (
  "%INSTDIR%\nssm.exe" remove CommissioningTool confirm     >nul 2>&1
  "%INSTDIR%\nssm.exe" remove CommissioningGateway confirm  >nul 2>&1
)
sc delete CommissioningTool      >nul 2>&1
sc delete CommissioningGateway   >nul 2>&1
timeout /t 2 /nobreak >nul

echo [3/5] Killing any node.exe / nssm.exe rooted in the install dir...
echo        (your other Node processes are left alone)
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='nssm.exe'\" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -like '*\CommissioningTool\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
timeout /t 2 /nobreak >nul

echo [4/5] Removing the locked program-files binaries...
if exist "%INSTDIR%" (
  rmdir /s /q "%INSTDIR%" 2>nul
  if exist "%INSTDIR%" (
    echo        Could not fully delete %INSTDIR% - a handle is still open.
    echo        Reboot once, then run the installer. Data is safe.
  ) else (
    echo        Cleared %INSTDIR%
  )
)

echo [5/5] Done.
echo.
echo   Now run CommissioningTool-Central-Setup-v2.40.6.exe (or newer) as admin.
echo.
pause
endlocal
