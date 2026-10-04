# Remove only the startup task. Configuration, credentials, sessions, and the
# browser profile are preserved unless the owner explicitly deletes them.
$ErrorActionPreference = 'Stop'
$TaskName = 'Alfred'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Startup task '$TaskName' removed. Private data was not touched."
} else {
  Write-Host "Startup task '$TaskName' was not registered."
}
