# Removes the tray shortcuts (Desktop and Startup). Does not stop the agent.
$ErrorActionPreference = 'Continue'
$removed = 0
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Startup'))) {
  $path = Join-Path $dir 'Alfred.lnk'
  if (Test-Path $path) {
    Remove-Item $path -Force
    Write-Output "Removed $path"
    $removed += 1
  }
}
if ($removed -eq 0) { Write-Output 'No tray shortcuts found.' }
