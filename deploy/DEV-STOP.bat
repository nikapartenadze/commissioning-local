@echo off
title IO Checkout Tool - Stop Dev Servers
color 0C

echo.
echo  Stopping development servers...
echo.

:: Stop dotnet processes
taskkill /F /IM "dotnet.exe" 2>nul

:: Stop node processes (be careful - this stops ALL node processes)
:: taskkill /F /IM "node.exe" 2>nul

:: Better: close the windows by title
taskkill /F /FI "WINDOWTITLE eq IO-Backend-Dev*" 2>nul
taskkill /F /FI "WINDOWTITLE eq IO-Frontend-Dev*" 2>nul

echo.
echo  Development servers stopped.
echo.
pause
