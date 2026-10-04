# Creates one-click shortcuts for the tray controller.
#   - Desktop shortcut (always)
#   - Startup folder shortcut (with -Startup)
param([switch]$Startup)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path $powershell)) { $powershell = 'powershell.exe' }

$shell = New-Object -ComObject WScript.Shell
function New-AgentShortcut([string]$Path) {
  $lnk = $shell.CreateShortcut($Path)
  $lnk.TargetPath = $powershell
  $lnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ProjectRoot\scripts\tray.ps1`""
  $lnk.WorkingDirectory = $ProjectRoot
  $lnk.IconLocation = if (Test-Path (Join-Path $ProjectRoot 'resources\logo.ico')) { Join-Path $ProjectRoot 'resources\logo.ico' } else { "$env:SystemRoot\System32\shell32.dll,13" }
  $lnk.Description = 'Alfred'
  $lnk.Save()
}

$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Alfred.lnk'
New-AgentShortcut $desktop
Write-Output "Desktop shortcut: $desktop"
Write-Output "Double-click it to show the tray and start the agent."

if ($Startup) {
  $startupDir = [Environment]::GetFolderPath('Startup')
  $startupShortcut = Join-Path $startupDir 'Alfred.lnk'
  New-AgentShortcut $startupShortcut
  Write-Output "Startup shortcut: $startupShortcut"
  Write-Output "The tray will appear at every sign-in."
} else {
  Write-Output "Tip: re-run with -Startup to also show the tray at every sign-in."
}
