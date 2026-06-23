# Provision the Logix Designer SDK Python venv for the commissioning tool's
# "Program Download" feature. BEST-EFFORT: if Studio 5000's SDK wheel or a
# compatible Python (3.12/3.13 — the wheel pins <3.14) is missing, exit 0
# quietly. The app then shows "Program download not available on this station";
# everything else (connect/configure/read I/O) is unaffected.
#
# Run automatically by the central installer, and re-runnable by hand on any
# download node:  powershell -ExecutionPolicy Bypass -File provision.ps1
#
# Creates  <this dir>\.venv  so lib/logix-sdk-bridge.ts (which resolves
# {cwd}/logix-sdk-bridge/.venv/Scripts/python.exe) finds it. The licensed SDK +
# Studio 5000 are NEVER bundled — they are installed separately on this box.

$ErrorActionPreference = 'Continue'
$bridgeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$venv = Join-Path $bridgeDir '.venv'
$venvPy = Join-Path $venv 'Scripts\python.exe'

function Done($msg) { Write-Host "[logix-provision] $msg"; exit 0 }

# Already provisioned + SDK imports? Nothing to do.
if (Test-Path $venvPy) {
  & $venvPy -c "import logix_designer_sdk" 2>$null
  if ($LASTEXITCODE -eq 0) { Done "venv already present and SDK imports — Program Download enabled." }
}

# The SDK wheel ships with a licensed Studio 5000 + Logix Designer SDK install.
$wheel = Get-ChildItem 'C:\Users\Public\Documents\Studio 5000\Logix Designer SDK\python\logix_designer_sdk-*.whl' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $wheel) { Done "Studio 5000 Logix Designer SDK wheel not found on this box — Program Download stays disabled (expected on tablets / non-engineering nodes)." }

# Find Python 3.13 or 3.12 (the wheel pins <3.14).
$pyVer = $null
foreach ($v in '3.13', '3.12') {
  & py "-$v" -c "import sys" 2>$null
  if ($LASTEXITCODE -eq 0) { $pyVer = $v; break }
}
if (-not $pyVer) { Done "Python 3.12 or 3.13 not found (the SDK wheel pins <3.14). Install one, then re-run provision.ps1, to enable Program Download." }

Write-Host "[logix-provision] Using Python $pyVer; wheel $($wheel.Name). Creating venv + installing SDK (bounded to 4 min)..."

# Bound the venv+pip so a hung/slow pip can never stall the installer.
$job = Start-Job -ScriptBlock {
  param($pyVer, $venv, $venvPy, $wheelPath)
  & py "-$pyVer" -m venv $venv
  & $venvPy -m pip install --quiet --upgrade pip
  & $venvPy -m pip install --quiet $wheelPath
} -ArgumentList $pyVer, $venv, $venvPy, $wheel.FullName

if (-not (Wait-Job $job -Timeout 240)) {
  Stop-Job $job -ErrorAction SilentlyContinue
  Done "Provisioning timed out (slow pip / no internet for deps). Re-run logix-sdk-bridge\provision.ps1 by hand."
}
Receive-Job $job 2>&1 | Out-Null

if (Test-Path $venvPy) {
  & $venvPy -c "import logix_designer_sdk" 2>$null
  if ($LASTEXITCODE -eq 0) { Done "SDK venv provisioned — Program Download enabled." }
  Done "venv created but SDK import failed — check the wheel/deps; see logix-sdk-bridge\README.md."
}
Done "venv not created — see logix-sdk-bridge\README.md to set it up by hand."
