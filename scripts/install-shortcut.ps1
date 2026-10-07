# Install the single Alfred desktop shortcut: start the agent and open its dashboard.
# -Startup is retained for older installations; Settings controls login startup.
param([switch]$Startup)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $powershell)) { $powershell = 'powershell.exe' }

$shell = New-Object -ComObject WScript.Shell
function New-AgentShortcut([string]$Path) {
  $lnk = $shell.CreateShortcut($Path)
  $lnk.TargetPath = $powershell
  $lnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ProjectRoot\scripts\tray.ps1`""
  $lnk.WorkingDirectory = $ProjectRoot
  $lnk.IconLocation = if (Test-Path -LiteralPath (Join-Path $ProjectRoot 'resources\logo.ico')) { Join-Path $ProjectRoot 'resources\logo.ico' } else { "$env:SystemRoot\System32\shell32.dll,13" }
  $lnk.Description = 'Start Alfred and open its dashboard'
  $lnk.Save()
}

$desktopDir = [Environment]::GetFolderPath('Desktop')
$desktop = Join-Path $desktopDir 'Alfred.lnk'
New-AgentShortcut $desktop
foreach ($name in @('Alfred Dashboard.lnk', 'Alfred UI.lnk')) {
  $obsolete = Join-Path $desktopDir $name
  if (Test-Path -LiteralPath $obsolete) { Remove-Item -LiteralPath $obsolete -Force }
}
Write-Output "Desktop shortcut: $desktop"
Write-Output 'Double-click Alfred to start the agent and open its dashboard.'

if ($Startup) {
  New-AgentShortcut (Join-Path ([Environment]::GetFolderPath('Startup')) 'Alfred.lnk')
  Write-Output 'Alfred will start at sign-in. Use Settings to turn startup off.'
} else {
  Write-Output 'Login startup is unchanged. Configure it in Settings.'
}
