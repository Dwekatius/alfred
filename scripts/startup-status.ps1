# Read-only inventory for the dashboard settings toggle.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'startup-control.ps1')
Get-AlfredStartupState | ConvertTo-Json -Depth 4 -Compress
