# Watches for local pairing to finish, then starts the scheduled controller once.
param([int]$TimeoutMinutes = 30)
$root = Join-Path $env:USERPROFILE '.pi\alfred'
$cfgPath = Join-Path $root 'config.json'
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'pair-watch.log'
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
while ((Get-Date) -lt $deadline) {
  try {
    $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
    if ($cfg.telegram.ownerUserId) {
      Add-Content $log ("[" + (Get-Date -Format o) + "] owner paired (" + $cfg.telegram.ownerUserId + "); starting controller task")
      Start-ScheduledTask -TaskName 'Alfred'
      exit 0
    }
  } catch { }
  Start-Sleep -Seconds 5
}
Add-Content $log ("[" + (Get-Date -Format o) + "] timed out waiting for pairing")
exit 1
