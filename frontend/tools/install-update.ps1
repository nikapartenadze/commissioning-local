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

$script:StartedAt = (Get-Date).ToString("o")

try {
  Write-State -Status "checking" -Message "Preparing update"

  $installDir = Get-RegistryValue -Path "HKLM:\Software\CommissioningTool" -Name "InstallDir"
  $dataDir = Get-RegistryValue -Path "HKLM:\Software\CommissioningTool" -Name "DataDir"

  if (-not $dataDir) {
    $dataDir = Join-Path $env:ProgramData "CommissioningTool"
  }

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
  Write-State -Status "error" -Message $_.Exception.Message -CompletedAt ((Get-Date).ToString("o"))
  throw
}
