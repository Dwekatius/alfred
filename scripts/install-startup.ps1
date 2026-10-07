# Register per-user interactive-logon startup for the controller.
# The task runs hidden, as the current interactive user, with limited rights.
# No token, key, or password is stored in the task arguments or XML.
param([string]$ConfigPath = '')
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'startup-control.ps1')
if (-not $ConfigPath) {
  $ConfigPath = if ($env:PI_TG_CONFIG) { $env:PI_TG_CONFIG } else { Join-Path $env:USERPROFILE '.pi\alfred\config.json' }
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$owner = "$($identity.Name)"
Write-Host "Installing startup task for $owner"

$principal = New-ScheduledTaskPrincipal -UserId $owner -LogonType Interactive -RunLevel Limited
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ProjectRoot\scripts\run-controller.ps1`" -ConfigPath `"$ConfigPath`"" `
  -WorkingDirectory $ProjectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $owner
$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
# Migrate the older tray installer to one startup source.
Remove-AlfredStartupShortcuts
$task = Get-ScheduledTask -TaskName $TaskName
Write-Host "Task '$TaskName' registered (state: $($task.State))."
Write-Host 'It starts at the next sign-in. Start it now with: Start-ScheduledTask -TaskName ''Alfred'''
Write-Host 'Removing startup keeps configuration, sessions, and the browser profile.'
