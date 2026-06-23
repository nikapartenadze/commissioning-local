@echo off
setlocal EnableDelayedExpansion
title autStand - Batch Controller Upload (Studio 5000 SDK)

echo ============================================================
echo   Batch Controller Upload  -  Studio 5000 Logix SDK
echo ============================================================
echo.

REM -- Find a Python that has the Logix Designer SDK installed (the venv built
REM    by provision.ps1). Override with LOGIX_SDK_PYTHON if yours is elsewhere. --
set "PY="
if defined LOGIX_SDK_PYTHON if exist "%LOGIX_SDK_PYTHON%" set "PY=%LOGIX_SDK_PYTHON%"
if not defined PY if exist "%~dp0.venv\Scripts\python.exe" set "PY=%~dp0.venv\Scripts\python.exe"
if not defined PY if exist "C:\Program Files (x86)\CommissioningTool\app\logix-sdk-bridge\.venv\Scripts\python.exe" set "PY=C:\Program Files (x86)\CommissioningTool\app\logix-sdk-bridge\.venv\Scripts\python.exe"
if not defined PY if exist "C:\Program Files\CommissioningTool\app\logix-sdk-bridge\.venv\Scripts\python.exe" set "PY=C:\Program Files\CommissioningTool\app\logix-sdk-bridge\.venv\Scripts\python.exe"

if not defined PY (
  echo ERROR: Could not find the Logix SDK Python venv.
  echo   Looked for: %%LOGIX_SDK_PYTHON%%, .\.venv, and the installed CommissioningTool venv.
  echo.
  echo   Fix: install Studio 5000 + the Logix Designer SDK, then run provision.ps1
  echo   in the CommissioningTool\app\logix-sdk-bridge folder to build the venv,
  echo   OR set LOGIX_SDK_PYTHON to a python.exe that has logix_designer_sdk.
  echo.
  pause
  exit /b 1
)

echo Using SDK Python: %PY%
echo Uploaded .acd files will be written to the CURRENT folder:
echo   %CD%
echo.
echo Tip: you can also drop a "controllers.txt" here (one comm path per line)
echo      instead of typing them.
echo.

REM Pass through any comm paths given on the command line; otherwise the script
REM reads controllers.txt or prompts. Output goes to the current folder.
"%PY%" "%~dp0batch_upload.py" --out "%CD%" %*

echo.
pause
endlocal
