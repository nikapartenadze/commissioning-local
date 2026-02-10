@echo off
echo ========================================
echo   Rebuilding Portable Distribution
echo ========================================
echo.
echo This will:
echo   1. Build the .NET backend
echo   2. Build the Next.js frontend
echo   3. Create portable distribution with all fixes
echo.
echo Press any key to continue...
pause >nul

powershell.exe -ExecutionPolicy Bypass -File "create-portable-distribution.ps1"

echo.
echo ========================================
echo   Build Complete!
echo ========================================
echo.
echo Your portable distribution is in: portable
echo.
pause

