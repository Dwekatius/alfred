# Creates the "Alfred UI" desktop shortcut (dashboard app window).
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path $powershell)) { $powershell = 'powershell.exe' }

$shell = New-Object -ComObject WScript.Shell
$path = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Alfred Dashboard.lnk'
$lnk = $shell.CreateShortcut($path)
$lnk.TargetPath = $powershell
$lnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ProjectRoot\scripts\dashboard-window.ps1`""
$lnk.WorkingDirectory = $ProjectRoot
$lnk.IconLocation = if (Test-Path (Join-Path $ProjectRoot 'resources\logo.ico')) { Join-Path $ProjectRoot 'resources\logo.ico' } else { "$env:SystemRoot\System32\shell32.dll,14" }
$lnk.Description = 'Alfred dashboard'
$lnk.Save()
Write-Output "Desktop shortcut: $path"
Write-Output 'Double-click it to open the dashboard app window.'
