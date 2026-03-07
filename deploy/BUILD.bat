@echo off
:: Quick build script - runs the PowerShell build
powershell -ExecutionPolicy Bypass -File "%~dp0BUILD-DISTRIBUTION.ps1"
pause
