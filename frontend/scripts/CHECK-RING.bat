@echo off
REM ===========================================================================
REM  DLR Ring Check - field tool. Read-only. No install required.
REM
REM  Double-click this file and type the controller IP(s) when prompted, or
REM  run from a command prompt:
REM      CHECK-RING.bat 192.168.1.10
REM      CHECK-RING.bat 192.168.1.10,192.168.1.11,192.168.1.12
REM
REM  A timestamped report is written next to this file so you can email it.
REM ===========================================================================
setlocal

set "SCRIPT=%~dp0Check-DlrRing.ps1"

if not exist "%SCRIPT%" (
  echo.
  echo   ERROR: Check-DlrRing.ps1 not found next to this batch file.
  echo   Both files must be kept together in the same folder.
  echo.
  pause
  exit /b 1
)

set "TARGETS=%~1"

if "%TARGETS%"=="" (
  echo.
  echo  ==========================================================
  echo   DLR RING CHECK  -  read-only, safe on a live ring
  echo  ==========================================================
  echo.
  echo   Enter the controller / Ethernet module IP address.
  echo   For several devices, separate them with commas:
  echo       192.168.1.10,192.168.1.11,192.168.1.12
  echo.
  set /p TARGETS="  IP address(es): "
)

if "%TARGETS%"=="" (
  echo.
  echo   No IP entered - nothing to do.
  echo.
  pause
  exit /b 1
)

REM Timestamped report filename: ring-YYYYMMDD-HHMMSS.txt
REM (uses PowerShell for the stamp - wmic is absent on newer Windows 11)
set "STAMP="
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"`) do set "STAMP=%%I"
if not defined STAMP set "STAMP=report"
set "OUT=%~dp0ring-%STAMP%.txt"

echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Gateway "%TARGETS%" -OutFile "%OUT%"

echo.
echo   ------------------------------------------------------------
echo   Report saved to: %OUT%
echo   ------------------------------------------------------------
echo.
pause
endlocal
