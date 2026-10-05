# Hidden logon wrapper. Task Scheduler tracks THIS process for its lifetime, so
# restarts-on-failure and exit codes reflect the real controller state.
param([string]$ConfigPath = '')
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
if (-not $ConfigPath) {
  $ConfigPath = if ($env:PI_TG_CONFIG) { $env:PI_TG_CONFIG } else { Join-Path $env:USERPROFILE '.pi\alfred\config.json' }
}
& node (Join-Path $ProjectRoot 'dist\src\main.js') --config $ConfigPath
exit $LASTEXITCODE
