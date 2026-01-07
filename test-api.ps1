# Test C# Backend API
Write-Host "Testing C# Backend API..." -ForegroundColor Green

try {
    # Test status endpoint
    Write-Host "Testing /api/status endpoint..." -ForegroundColor Yellow
    $statusResponse = Invoke-WebRequest -Uri "http://localhost:5000/api/status" -Method GET
    Write-Host "Status: $($statusResponse.StatusCode)" -ForegroundColor Green
    Write-Host "Response: $($statusResponse.Content)" -ForegroundColor Cyan
    
    # Test IOs endpoint
    Write-Host "`nTesting /api/ios endpoint..." -ForegroundColor Yellow
    $iosResponse = Invoke-WebRequest -Uri "http://localhost:5000/api/ios" -Method GET
    Write-Host "Status: $($iosResponse.StatusCode)" -ForegroundColor Green
    $iosData = $iosResponse.Content | ConvertFrom-Json
    Write-Host "IOs Count: $($iosData.Count)" -ForegroundColor Cyan
    
} catch {
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Make sure the C# backend is running on http://localhost:5000" -ForegroundColor Yellow
}

Write-Host "`nAPI Test Complete!" -ForegroundColor Green
