@echo off
setlocal
set "ROOT=%~dp0"
set "NODE=%ROOT%node\node.exe"
set "NPX=%ROOT%node\npx.cmd"
set "PATH=%ROOT%node;%PATH%"
set "APP=%ROOT%app"
echo.
echo Seeding network topology data...
cd /d "%APP%"
"%NPX%" tsx prisma/seed-network.ts
if %errorlevel% equ 0 (echo Network data seeded successfully.) else (echo ERROR: Seeding failed.)
echo.
pause
