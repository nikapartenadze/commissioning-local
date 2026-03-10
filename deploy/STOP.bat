@echo off
echo Stopping IO Checkout Tool...
taskkill /f /im "node.exe" /fi "WINDOWTITLE eq IO Checkout*" 2>nul
taskkill /f /im "node.exe" /fi "MEMUSAGE gt 50000" 2>nul
echo Stopped.
pause
