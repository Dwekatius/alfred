# Local backup of configuration, database, sessions, and model overlay.
# Chrome profile data is copied only while Chrome is closed (no SingletonLock).
# WARNING: the backup contains private messages and browser data. Keep it local.
param(
  [string]$Destination,
  [switch]$IncludeProfile
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
$configPath = if ($env:PI_TG_CONFIG) { $env:PI_TG_CONFIG } else { Join-Path $env:USERPROFILE '.pi\alfred\config.json' }
$dataRoot = Join-Path $env:USERPROFILE '.pi\alfred'
if (-not $Destination) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $Destination = Join-Path $env:USERPROFILE "Documents\alfred-backup-$stamp"
}
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
Write-Host "Backing up to $Destination"

if (Test-Path $configPath) { Copy-Item $configPath (Join-Path $Destination 'config.json') -Force }
$agentDir = Join-Path $dataRoot 'agent'
if (Test-Path $agentDir) { Copy-Item $agentDir (Join-Path $Destination 'agent') -Recurse -Force }
$sessionsDir = Join-Path $dataRoot 'sessions'
if (Test-Path $sessionsDir) { Copy-Item $sessionsDir (Join-Path $Destination 'sessions') -Recurse -Force }
$manifestsDir = Join-Path $dataRoot 'manifests'
if (Test-Path $manifestsDir) { Copy-Item $manifestsDir (Join-Path $Destination 'manifests') -Recurse -Force }

# Consistent SQLite backup via the SQLite backup API from the project runtime.
$dbPath = Join-Path $dataRoot 'state\jobs.sqlite'
if (Test-Path $dbPath) {
  $target = Join-Path $Destination 'jobs.sqlite'
  node (Join-Path $ProjectRoot 'scripts\backup-db.mjs') $dbPath $target
  Write-Host 'Database checkpointed.'
}

if ($IncludeProfile) {
  $profile = Join-Path $dataRoot 'browser\profile'
  $lock = Join-Path $profile 'SingletonLock'
  if (Test-Path $lock) {
    Write-Warning 'Chrome appears to be running (SingletonLock present). Close the dedicated browser before backing up its profile.'
  } elseif (Test-Path $profile) {
    Copy-Item $profile (Join-Path $Destination 'browser-profile') -Recurse -Force
    Write-Host 'Browser profile copied.'
  }
} else {
  Write-Host 'Browser profile not included (pass -IncludeProfile while Chrome is closed).'
}

Write-Host 'DPAPI secret blobs are user/machine bound; restore on another machine requires re-running npm run pair.'
Write-Host 'Backup complete.'
