# One-shot hidden launcher used by the dashboard. Does not enable sign-in startup.
param([string]$ConfigPath = '')
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not $ConfigPath) {
  $ConfigPath = if ($env:PI_TG_CONFIG) { $env:PI_TG_CONFIG } else { Join-Path $env:USERPROFILE '.pi\alfred\config.json' }
}
. (Join-Path $PSScriptRoot 'controller-control.ps1')
if (Start-Agent) { Write-Output 'started'; exit 0 }
Write-Error 'Controller did not become ready; check the Alfred logs folder.'
exit 1
