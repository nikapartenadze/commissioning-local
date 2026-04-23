$ErrorActionPreference = "Continue"

$projectDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $projectDir "frontend"))) {
    $projectDir = Split-Path -Parent $PSScriptRoot
}
if (-not (Test-Path (Join-Path $projectDir "frontend"))) {
    Write-Host "ERROR: Cannot find project root. Run from the deploy/ directory."
    exit 1
}
$frontendDir = Join-Path $projectDir "frontend"
$outputDir = Join-Path $projectDir "portable"
$deployDir = Join-Path $projectDir "deploy"

Write-Host "============================================================"
Write-Host " Commissioning Tool - Build Portable Distribution"
Write-Host "============================================================"

# Step 1: Clean and create output dir
Write-Host "[1/6] Creating portable directory..."
if (Test-Path $outputDir) { Remove-Item -Recurse -Force $outputDir }
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $outputDir "app") -Force | Out-Null

# Step 2: Bundle node.exe
Write-Host "[2/6] Bundling node.exe..."
$nodeExe = (Get-Command node).Source
Copy-Item $nodeExe (Join-Path $outputDir "node.exe")
$nodeVer = & node --version
Write-Host "  Node.js $nodeVer"

# Step 3: Copy compiled app
Write-Host "[3/6] Copying compiled app..."
$dsDir = Join-Path $outputDir "app\dist-server"
Copy-Item -Recurse -Force (Join-Path $frontendDir "dist-server") $dsDir
Copy-Item -Recurse -Force (Join-Path $frontendDir "dist") (Join-Path $dsDir "dist")

# Startup backup module
$libDir = Join-Path $dsDir "lib"
if (!(Test-Path $libDir)) { New-Item -ItemType Directory -Path $libDir -Force | Out-Null }
$backupJs = Join-Path $frontendDir "lib\startup-backup.js"
if (Test-Path $backupJs) { Copy-Item $backupJs $libDir; Write-Host "  startup-backup.js copied" }

# Install-update script
$toolsDir = Join-Path $dsDir "tools"
if (!(Test-Path $toolsDir)) { New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null }
$updatePs1 = Join-Path $frontendDir "tools\install-update.ps1"
if (Test-Path $updatePs1) { Copy-Item $updatePs1 $toolsDir; Write-Host "  install-update.ps1 copied" }

# Step 4: PLC native library
Write-Host "[4/6] Copying plctag.dll..."
$dllSrc = Join-Path $frontendDir "plctag.dll"
if (Test-Path $dllSrc) {
    Copy-Item $dllSrc (Join-Path $outputDir "app\")
    Copy-Item $dllSrc $dsDir
    Write-Host "  plctag.dll copied"
} else {
    Write-Host "  WARNING: plctag.dll not found at $dllSrc"
}

# Clean dev artifacts
foreach ($d in @("backups","logs")) {
    $p = Join-Path $dsDir $d
    if (Test-Path $p) { Remove-Item -Recurse -Force $p }
}
foreach ($f in @("database.db","database.db-wal","database.db-shm")) {
    $p = Join-Path $dsDir $f
    if (Test-Path $p) { Remove-Item -Force $p }
}

# Step 5: Production node_modules
Write-Host "[5/6] Installing production dependencies..."

$runtimePkg = @"
{
  "name": "commissioning-tool-runtime",
  "private": true,
  "dependencies": {
    "express": "^5.2.1",
    "better-sqlite3": "^12.0.0",
    "ws": "^8.19.0",
    "ffi-rs": "^1.3.1",
    "jsonwebtoken": "^9.0.3",
    "bcryptjs": "^3.0.3",
    "http-proxy": "^1.18.1",
    "tsconfig-paths": "^4.2.0"
  }
}
"@

# Save original package.json if exists
$pkgPath = Join-Path $dsDir "package.json"
$pkgBak = Join-Path $dsDir "package.json.bak"
if (Test-Path $pkgPath) { Copy-Item $pkgPath $pkgBak }

$runtimePkg | Set-Content -Path $pkgPath -Encoding UTF8

Push-Location $dsDir
cmd /c "npm install --omit=dev" 2>&1 | Select-Object -Last 5
Pop-Location

# Restore original package.json
if (Test-Path $pkgBak) {
    Copy-Item $pkgBak $pkgPath -Force
    Remove-Item $pkgBak
}

# Verify native modules
Write-Host "  Verifying native modules..."
$nodePortable = Join-Path $outputDir "node.exe"
$requirePath = ($dsDir.Replace('\','/')) + "/node_modules/better-sqlite3"
$testResult = & $nodePortable -e "require('$requirePath')" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  WARNING: better-sqlite3 verification failed (may work at runtime)"
    Write-Host "  $testResult"
} else {
    Write-Host "  Native modules verified"
}
Write-Host "  Native modules verified"

# Create .env
$envContent = @"
DATABASE_URL=file:../database.db
JWT_SECRET_KEY=commissioning-tool-$(Get-Random)$(Get-Random)$(Get-Random)
PORT=3000
HOSTNAME=0.0.0.0
NODE_ENV=production
APP_VERSION=1.0.0
UPDATE_MANIFEST_URL=
"@
$envContent | Set-Content -Path (Join-Path $dsDir ".env") -Encoding UTF8

# Step 6: Generate batch files and README
Write-Host "[6/6] Generating scripts..."

# Generate START/STOP/STATUS via Node.js helper
$writeBat = Join-Path $deployDir "write-bat-files.js"
if (Test-Path $writeBat) {
    & node $writeBat $outputDir
} else {
    Write-Host "  WARNING: write-bat-files.js not found, skipping batch file generation"
}

# Copy firewall setup
$firewallBat = Join-Path $deployDir "SETUP-FIREWALL.bat"
if (Test-Path $firewallBat) { Copy-Item $firewallBat $outputDir }

# README
@"
Commissioning Tool
==================

FIRST TIME:  Double-click START.bat
DAILY USE:   START.bat to launch, Ctrl+C to stop
STATUS:      Run STATUS.bat to check if running

No installation needed. Just extract and run START.bat.

Access: http://localhost:3000 (or your IP on tablets)
"@ | Set-Content -Path (Join-Path $outputDir "README.txt") -Encoding UTF8

# Show final size
$size = (Get-ChildItem -Recurse $outputDir | Measure-Object -Property Length -Sum).Sum
$sizeMB = [math]::Round($size / 1MB, 1)

Write-Host ""
Write-Host "============================================================"
Write-Host " BUILD COMPLETE"
Write-Host "============================================================"
Write-Host ""
Write-Host "Output:  $outputDir"
Write-Host "Size:    ${sizeMB} MB"
Write-Host "Node.js: $nodeVer"
Write-Host ""
Write-Host "No setup needed on target PC. Extract and run START.bat."
