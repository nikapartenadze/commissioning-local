# Local battle soak launcher (Windows). Wraps the same scenarios the CI runs.
#   .\run-local.ps1 -Scenario all-night -Minutes 480
# Scenarios: s1 (clean), s2 (PLC storm), s3 (cloud flap), s6 (CIP sat),
#            mutate (cloud-side changes), all-night (everything at once).
param(
  [string]$Scenario = "all-night",
  [int]$Minutes = 480,
  [int]$Bots = 6
)
$ErrorActionPreference = "Stop"
$cf = Join-Path $PSScriptRoot "docker-compose.battle.yml"

$env:RUN_ID    = "$Scenario-$(Get-Date -Format yyyyMMdd-HHmm)"
$env:SOAK_MINUTES = "$Minutes"
$env:BOTS      = "$Bots"
$env:THINK_MIN_MS = "500"; $env:THINK_MAX_MS = "2500"
$env:HOT_SET   = "10";  $env:HOT_FRACTION = "0.35"
$env:DOWNLOAD_STORM = ""; $env:CLOUD_FLAP = ""; $env:COMPOSE_PROFILES = ""
$env:FLAP_BUDGET = "0"

switch ($Scenario) {
  "s1" {}
  "s2" { $env:DOWNLOAD_STORM = "20,40" }
  "s3" { $env:CLOUD_FLAP = "2,6"; $env:FLAP_BUDGET = "120" }
  "s6" {}  # set delay via chaos after boot
  "mutate" { $env:CLOUD_FLAP = "3,8"; $env:FLAP_BUDGET = "120"; $env:COMPOSE_PROFILES = "mutate" }
  "all-night" {
    # Everything: PLC downloads + cloud flap + cloud-side mutations + load.
    $env:DOWNLOAD_STORM = "25,45"; $env:CLOUD_FLAP = "3,9"; $env:FLAP_BUDGET = "200"
    $env:COMPOSE_PROFILES = "mutate"; $env:MUTATE_PERIOD_SEC = "180"
  }
  default { throw "unknown scenario $Scenario" }
}

Write-Host "Launching battle: $($env:RUN_ID)  soak=$Minutes min  scenario=$Scenario"
docker compose -f $cf -p battle up --build -d
Write-Host "`nWatch:   docker logs -f battle-observer-1"
Write-Host "UI:      http://localhost:13000  (tool)   http://localhost:13001 (cloud)"
Write-Host "Verdict: docker wait battle-observer-1; docker cp battle-observer-1:/runs/$($env:RUN_ID) ./runs/"
