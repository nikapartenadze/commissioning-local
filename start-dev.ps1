# IO Checkout Tool Development Startup Script
Write-Host "Starting IO Checkout Tool Development Environment..." -ForegroundColor Green
Write-Host ""

# Get the script directory
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Kill any existing processes first
Write-Host "Stopping any existing IO Checkout processes..." -ForegroundColor Yellow
Get-Process | Where-Object {$_.ProcessName -like "*IO*" -or $_.ProcessName -like "*Checkout*" -or $_.ProcessName -like "*dotnet*"} | Stop-Process -Force -ErrorAction SilentlyContinue

# Clean build directories to prevent lock issues
Write-Host "Cleaning build directories..." -ForegroundColor Yellow
$csharpPath = Join-Path $scriptDir "IO-Checkout-Tool copy"
Remove-Item -Path "$csharpPath\bin" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "$csharpPath\obj" -Recurse -Force -ErrorAction SilentlyContinue

# Start C# Backend
Write-Host "Starting C# Backend..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$csharpPath'; dotnet run"

# Wait for backend to start
Write-Host "Waiting 5 seconds for C# backend to start..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

# Start Next.js Frontend
Write-Host "Starting Next.js Frontend..." -ForegroundColor Yellow
$nextjsPath = Join-Path $scriptDir "commissioning"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$nextjsPath'; npm run dev"

Write-Host ""
Write-Host "Both applications are starting..." -ForegroundColor Green
Write-Host "C# Backend: http://localhost:5000" -ForegroundColor Cyan
Write-Host "Next.js Frontend: http://localhost:3000" -ForegroundColor Cyan
Write-Host ""
Write-Host "Press any key to close this window..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
