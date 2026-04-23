/**
 * Writes START.bat, STOP.bat, STATUS.bat to a target directory.
 * Uses CRLF line endings — required for Windows batch files.
 *
 * Usage: node write-bat-files.js <output-dir>
 */

const fs = require('fs');
const path = require('path');

const outDir = process.argv[2];
if (!outDir) {
  console.error('Usage: node write-bat-files.js <output-dir>');
  process.exit(1);
}

const CRLF = '\r\n';

function writeBat(name, lines) {
  const filePath = path.join(outDir, name);
  fs.writeFileSync(filePath, lines.join(CRLF) + CRLF);
  console.log(`  Written ${name} (${lines.length} lines)`);
}

// ── START.bat ──
writeBat('START.bat', [
  '@echo off',
  'setlocal',
  'set "ROOT=%~dp0"',
  'set "NODE=%ROOT%node.exe"',
  'set "APP=%ROOT%app"',
  '',
  'if not exist "%NODE%" (',
  '    echo ERROR: node.exe not found. Re-extract the portable folder.',
  '    pause',
  '    exit /b 1',
  ')',
  '',
  'REM Stop the CommissioningTool Windows service if it is running',
  'sc query CommissioningTool >nul 2^>^&1',
  'if %errorlevel% equ 0 (',
  '    echo Stopping CommissioningTool service...',
  '    net stop CommissioningTool >nul 2^>^&1',
  '    if %errorlevel% neq 0 (',
  '        echo   Need admin rights to stop the service. Requesting elevation...',
  '        powershell -NoProfile -Command "Start-Process cmd -ArgumentList \'/c net stop CommissioningTool\' -Verb RunAs -Wait" 2>nul',
  '    )',
  '    timeout /t 3 /nobreak >nul',
  ')',
  '',
  'REM Kill any remaining orphaned processes on port 3000 and 3102',
  "for /f \"tokens=5\" %%p in ('netstat -ano ^| findstr \":3000 \" ^| findstr \"LISTENING\"') do (",
  '    echo Stopping previous instance ^(PID %%p^)...',
  '    taskkill /F /PID %%p >nul 2^>^&1',
  ')',
  "for /f \"tokens=5\" %%p in ('netstat -ano ^| findstr \":3102 \" ^| findstr \"LISTENING\"') do (",
  '    taskkill /F /PID %%p >nul 2^>^&1',
  ')',
  'REM Wait for ports to release',
  'timeout /t 2 /nobreak >nul',
  '',
  'echo ============================================================',
  'echo  Commissioning Tool',
  'echo ============================================================',
  'echo.',
  'echo   App:   http://localhost:3000',
  'echo.',
  'echo   Tablet access:',
  "for /f \"tokens=2 delims=:\" %%a in ('ipconfig ^| findstr /i \"IPv4\"') do (",
  '    for /f "tokens=1" %%b in ("%%a") do (',
  '        echo     http://%%b:3000',
  '    )',
  ')',
  'echo.',
  'echo   Press Ctrl+C to stop.',
  'echo ============================================================',
  '',
  'cd /d "%APP%"',
  '"%NODE%" --max-old-space-size=256 --optimize-for-size dist-server\\server-express.js',
  'echo.',
  'echo Server stopped.',
  'pause',
]);

// ── STOP.bat ──
writeBat('STOP.bat', [
  '@echo off',
  'echo Stopping Commissioning Tool...',
  "for /f \"tokens=5\" %%p in ('netstat -ano ^| findstr \":3000 \" ^| findstr \"LISTENING\"') do (",
  '    taskkill /F /PID %%p >nul 2^>^&1',
  '    echo   Stopped ^(PID %%p^)',
  ')',
  "for /f \"tokens=5\" %%p in ('netstat -ano ^| findstr \":3102 \" ^| findstr \"LISTENING\"') do (",
  '    taskkill /F /PID %%p >nul 2^>^&1',
  ')',
  'echo Done.',
  'pause',
]);

// ── STATUS.bat ──
writeBat('STATUS.bat', [
  '@echo off',
  'echo ============================================================',
  'echo  Commissioning Tool - Status',
  'echo ============================================================',
  'echo.',
  'netstat -an | findstr ":3000 " | findstr "LISTENING" >nul 2>nul',
  'if %errorlevel% equ 0 (echo   App ^(port 3000^): RUNNING) else (echo   App ^(port 3000^): NOT RUNNING)',
  'echo.',
  'echo Tablet access URLs:',
  "for /f \"tokens=2 delims=:\" %%a in ('ipconfig ^| findstr /i \"IPv4\"') do (",
  '    for /f "tokens=1" %%b in ("%%a") do (',
  '        echo   http://%%b:3000',
  '    )',
  ')',
  'echo.',
  'pause',
]);
