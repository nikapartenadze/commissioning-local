# PowerShell script to import diagnostic data into SQLite database
# Run this after starting the application for the first time

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Diagnostic Data Import Tool" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$databasePath = "backend\database.db"
$sqlFile = "backend\SampleDiagnosticData.sql"

# Check if database exists
if (-not (Test-Path $databasePath)) {
    Write-Host "❌ Error: Database not found at $databasePath" -ForegroundColor Red
    Write-Host "Please start the application first to create the database." -ForegroundColor Yellow
    pause
    exit 1
}

# Check if SQL file exists
if (-not (Test-Path $sqlFile)) {
    Write-Host "❌ Error: SQL file not found at $sqlFile" -ForegroundColor Red
    pause
    exit 1
}

Write-Host "Found database: $databasePath" -ForegroundColor Green
Write-Host "Found SQL file: $sqlFile" -ForegroundColor Green
Write-Host ""

# Check if sqlite3 is available
$sqlite3 = Get-Command sqlite3 -ErrorAction SilentlyContinue

if ($sqlite3) {
    Write-Host "Using sqlite3 command line tool..." -ForegroundColor Cyan
    sqlite3 $databasePath < $sqlFile
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✅ Diagnostic data imported successfully!" -ForegroundColor Green
    } else {
        Write-Host "❌ Error importing data" -ForegroundColor Red
    }
} else {
    Write-Host "sqlite3 not found in PATH." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Please use one of these methods:" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Method 1: DBeaver (Recommended)" -ForegroundColor White
    Write-Host "  1. Open DBeaver" -ForegroundColor Gray
    Write-Host "  2. Connect to: $databasePath" -ForegroundColor Gray
    Write-Host "  3. Open: $sqlFile" -ForegroundColor Gray
    Write-Host "  4. Execute the SQL script" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Method 2: Via API" -ForegroundColor White
    Write-Host "  The application will auto-create tables on startup." -ForegroundColor Gray
    Write-Host "  Then use: POST http://localhost:5000/api/diagnostics/import" -ForegroundColor Gray
    Write-Host ""
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Next Steps" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "1. Start the application (backend + frontend)" -ForegroundColor White
Write-Host "2. Open: http://localhost:3000" -ForegroundColor White
Write-Host "3. Test the fail workflow with diagnostic steps!" -ForegroundColor White
Write-Host ""
Write-Host "See DIAGNOSTIC-SYSTEM-GUIDE.md for full documentation." -ForegroundColor Cyan
Write-Host ""
pause

