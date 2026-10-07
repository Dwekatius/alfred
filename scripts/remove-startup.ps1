# Remove the startup task and legacy login shortcuts. Configuration, credentials, sessions, and the
# browser profile are preserved unless the owner explicitly deletes them.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'startup-control.ps1')
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Startup task '$TaskName' removed. Private data was not touched."
} else {
  Write-Host "Startup task '$TaskName' was not registered."
}
Remove-AlfredStartupShortcuts
Write-Host 'Alfred login shortcuts removed. The desktop shortcut and running assistant are unchanged.'
