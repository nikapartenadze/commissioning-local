# Quick fix script to copy missing static files to existing distribution

Write-Host "Fixing frontend static files..." -ForegroundColor Yellow

$distributionFolder = "IO-Checkout-Tool-Portable"
$frontendSource = "commissioning-tool-frontend"

# Create .next directory in frontend
New-Item -ItemType Directory -Path "$distributionFolder\frontend\.next" -Force | Out-Null

# Copy static assets
if (Test-Path "$frontendSource\.next\static") {
    Write-Host "Copying static assets..." -ForegroundColor Cyan
    Copy-Item -Path "$frontendSource\.next\static" -Destination "$distributionFolder\frontend\.next\static" -Recurse -Force
    Write-Host "✅ Static assets copied!" -ForegroundColor Green
} else {
    Write-Host "❌ Static folder not found in source!" -ForegroundColor Red
}

# Copy public folder if it exists
if (Test-Path "$frontendSource\public") {
    Write-Host "Copying public assets..." -ForegroundColor Cyan
    Copy-Item -Path "$frontendSource\public" -Destination "$distributionFolder\frontend\public" -Recurse -Force
    Write-Host "✅ Public assets copied!" -ForegroundColor Green
}

Write-Host ""
Write-Host "✅ Frontend static files fixed!" -ForegroundColor Green
Write-Host "Now try running START.bat again." -ForegroundColor Yellow

