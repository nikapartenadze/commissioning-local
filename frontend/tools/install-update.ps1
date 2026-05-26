param(
  [Parameter(Mandatory = $true)][string]$InstallerUrl,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
  [Parameter(Mandatory = $true)][string]$StatePath,
  [string]$ServiceName = "CommissioningTool"
)

$ErrorActionPreference = "Stop"

function Write-State {
  param(
    [string]$Status,
    [string]$Message,
    [string]$CompletedAt = $null
  )

  $payload = [ordered]@{
    status      = $Status
    message     = $Message
    version     = $ExpectedVersion
    installerUrl= $InstallerUrl
    startedAt   = $script:StartedAt
    completedAt = $CompletedAt
  }

  $stateDir = Split-Path -Parent $StatePath
  if (-not (Test-Path $stateDir)) {
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
  }
  $payload | ConvertTo-Json -Depth 4 | Set-Content -Path $StatePath -Encoding UTF8
  # Echo every transition to the transcript too, so a run that dies before a
  # terminal state still shows exactly which step it reached.
  Write-Host ("[{0}] {1} - {2}" -f (Get-Date).ToString("HH:mm:ss"), $Status, $Message)
}

function Get-RegistryValue {
  param([string]$Path, [string]$Name)
  try {
    return (Get-ItemProperty -Path $Path -Name $Name -ErrorAction Stop).$Name
  } catch {
    return $null
  }
}

function Wait-For-ServiceState {
  param(
    [string]$Name,
    [string]$DesiredState,
    [int]$TimeoutSeconds = 30
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if ($null -eq $svc) { return $true }
    if ($svc.Status.ToString().Equals($DesiredState, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
    Start-Sleep -Seconds 1
  }
  return $false
}

# Wait for any node.exe whose binary lives under $InstallDir to actually
# EXIT. The service reporting Stopped can precede node fully releasing
# its LoadLibrary handle on plctag.dll -- and while that handle is alive,
# the silent installer File overwrite is skipped, leaving the DLL
# missing after the upgrade. Polling the process list closes that race.
function Wait-NodeExit {
  param([string]$InstallDir, [int]$TimeoutSeconds = 30)
  if (-not $InstallDir) { return $true }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($InstallDir, [System.StringComparison]::OrdinalIgnoreCase) }
    if (-not $procs) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

# True only when the native PLC library landed in BOTH locations the
# runtime searches. The web server starts and /api/health returns
# healthy even when libplctag failed to load (PLC init is non-fatal to
# HTTP), so a green health check is NOT proof the update succeeded -- this
# is the real gate.
function Test-PlcDll {
  param([string]$InstallDir)
  if (-not $InstallDir) { return $false }
  $a = Join-Path $InstallDir 'app\plctag.dll'
  $b = Join-Path $InstallDir 'app\dist-server\plctag.dll'
  return ((Test-Path $a) -and (Test-Path $b))
}

# Best-effort Defender path exclusion so the unsigned plctag.dll isn't
# quarantined on newer Win11 laptops. No-ops under third-party AV; may be
# refused on org-managed Defender with Tamper Protection.
function Add-DefenderExclusion {
  param([string]$InstallDir, [string]$DataDir)
  try {
    if ($InstallDir) { Add-MpPreference -ExclusionPath $InstallDir -ErrorAction SilentlyContinue }
    if ($DataDir)    { Add-MpPreference -ExclusionPath $DataDir -ErrorAction SilentlyContinue }
  } catch { }
}

$script:StartedAt = (Get-Date).ToString("o")

# Transcript so a failed/interrupted run leaves a diagnosable trail. The updater
# is spawned detached with stdio: 'ignore', so without this it ran completely
# blind -- when the ps1 died mid-flight (e.g. Stop-Service tearing down the
# service process tree took this child with it) there was zero evidence of
# which step failed. Best-effort: Start-Transcript can be refused on some hosts.
$logDir = Join-Path (Split-Path -Parent $StatePath) 'logs'
try {
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
  $transcriptPath = Join-Path $logDir ("update-{0}.log" -f (Get-Date -Format "yyyyMMddTHHmmss"))
  Start-Transcript -Path $transcriptPath -Append | Out-Null
} catch { }

Write-Host "=== CommissioningTool update ==="
Write-Host ("Target version : {0}" -f $ExpectedVersion)
Write-Host ("Installer URL  : {0}" -f $InstallerUrl)
Write-Host ("Service name   : {0}" -f $ServiceName)
Write-Host ("Started        : {0}" -f $script:StartedAt)

try {
  Write-State -Status "checking" -Message "Preparing update"

  $installDir = Get-RegistryValue -Path "HKLM:\Software\CommissioningTool" -Name "InstallDir"
  $dataDir = Get-RegistryValue -Path "HKLM:\Software\CommissioningTool" -Name "DataDir"

  if (-not $installDir) {
    $installDir = Join-Path ${env:ProgramFiles} "CommissioningTool"
  }
  if (-not $dataDir) {
    $dataDir = Join-Path $env:ProgramData "CommissioningTool"
  }

  # Set the Defender exclusion up front so the freshly-written DLL lands in
  # an already-excluded path (the installer also does this, but doing it
  # here covers the window before/around the install too).
  Add-DefenderExclusion -InstallDir $installDir -DataDir $dataDir

  if (-not (Test-Path $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  }

  $backupDir = Join-Path $dataDir "backups"
  if (-not (Test-Path $backupDir)) {
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
  }

  $tempRoot = Join-Path $env:TEMP "CommissioningToolUpdate"
  if (-not (Test-Path $tempRoot)) {
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
  }

  $installerPath = Join-Path $tempRoot ("CommissioningTool-Setup-v{0}.exe" -f $ExpectedVersion)

  Write-State -Status "downloading" -Message "Downloading installer"
  Invoke-WebRequest -Uri $InstallerUrl -OutFile $installerPath -UseBasicParsing

  Write-State -Status "installing" -Message "Stopping service"
  $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -ne 'Stopped') {
    Stop-Service -Name $ServiceName -Force
    if (-not (Wait-For-ServiceState -Name $ServiceName -DesiredState "Stopped" -TimeoutSeconds 45)) {
      throw "Service $ServiceName did not stop in time"
    }
  }

  # Service "Stopped" != node.exe fully exited. Wait for the process to
  # die so it isn't still holding a LoadLibrary lock on plctag.dll when
  # the installer tries to overwrite it (the v2.39.0 dropped-DLL bug).
  if (-not (Wait-NodeExit -InstallDir $installDir -TimeoutSeconds 30)) {
    Write-State -Status "installing" -Message "node.exe still running; forcing kill before install"
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installDir, [System.StringComparison]::OrdinalIgnoreCase) } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
  }

  $timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
  $dbPath = Join-Path $dataDir "database.db"
  if (Test-Path $dbPath) {
    Copy-Item -Path $dbPath -Destination (Join-Path $backupDir "database-$timestamp-pre-update.db") -Force
  }
  $configPath = Join-Path $dataDir "config.json"
  if (Test-Path $configPath) {
    Copy-Item -Path $configPath -Destination (Join-Path $backupDir "config-$timestamp-pre-update.json") -Force
  }

  Write-State -Status "installing" -Message "Running silent installer"
  $installProcess = Start-Process -FilePath $installerPath -ArgumentList "/S" -Wait -PassThru
  if ($installProcess.ExitCode -ne 0) {
    throw "Installer exited with code $($installProcess.ExitCode)"
  }

  # Verify the native PLC library actually landed. If it didn't (locked
  # overwrite skipped it, or AV grabbed it), make absolutely sure node is
  # dead, re-assert the Defender exclusion, and run the installer once
  # more -- the second pass writes into a now-empty, excluded path. Only
  # give up (and report FAILURE, not success) if it's still missing, which
  # means Windows Security is actively blocking it (Smart App Control /
  # managed AV) and the laptop needs manual remediation.
  if (-not (Test-PlcDll -InstallDir $installDir)) {
    Write-State -Status "installing" -Message "plctag.dll missing after install - re-asserting exclusion and retrying"
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    Wait-For-ServiceState -Name $ServiceName -DesiredState "Stopped" -TimeoutSeconds 30 | Out-Null
    Wait-NodeExit -InstallDir $installDir -TimeoutSeconds 20 | Out-Null
    Add-DefenderExclusion -InstallDir $installDir -DataDir $dataDir
    $retry = Start-Process -FilePath $installerPath -ArgumentList "/S" -Wait -PassThru
    if ($retry.ExitCode -ne 0) {
      throw "Installer retry exited with code $($retry.ExitCode)"
    }
    if (-not (Test-PlcDll -InstallDir $installDir)) {
      throw "plctag.dll is still missing after reinstall. Windows Security (Smart App Control or managed AV) is blocking the unsigned DLL on this machine. Manual fix required: add a Defender exclusion for '$installDir' (or turn off Smart App Control), then reinstall."
    }
  }

  Write-State -Status "restarting" -Message "Starting service"
  Start-Service -Name $ServiceName
  if (-not (Wait-For-ServiceState -Name $ServiceName -DesiredState "Running" -TimeoutSeconds 45)) {
    throw "Service $ServiceName did not return to Running state"
  }

  $healthy = $false
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 5
      if ($health.status -eq "healthy") {
        $healthy = $true
        break
      }
    } catch {
      Start-Sleep -Seconds 2
    }
  }

  if (-not $healthy) {
    throw "Health check did not pass after update"
  }

  Write-State -Status "success" -Message "Update installed successfully" -CompletedAt ((Get-Date).ToString("o"))
} catch {
  Write-Host "ERROR: $($_.Exception.Message)"
  Write-Host $_.ScriptStackTrace
  Write-State -Status "error" -Message $_.Exception.Message -CompletedAt ((Get-Date).ToString("o"))
  throw
} finally {
  try { Stop-Transcript | Out-Null } catch { }
}
