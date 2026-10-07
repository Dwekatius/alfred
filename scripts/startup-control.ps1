# Windows startup sources managed by Alfred. Shared by settings and installers.
$TaskName = 'Alfred'

function Get-AlfredStartupFolders {
  @([Environment]::GetFolderPath('Startup'), [Environment]::GetFolderPath('CommonStartup'))
}

function Get-AlfredStartupShortcuts {
  foreach ($folder in @(Get-AlfredStartupFolders)) {
    if ($folder) {
      $path = Join-Path $folder 'Alfred.lnk'
      if (Test-Path -LiteralPath $path) { $path }
    }
  }
}

function Remove-AlfredStartupShortcuts {
  foreach ($path in @(Get-AlfredStartupShortcuts)) {
    Remove-Item -LiteralPath $path -Force -ErrorAction Stop
  }
}

function Get-AlfredStartupState {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  $sources = @()
  if ($task) {
    $sources += [pscustomobject]@{ kind = 'task'; enabled = [bool]$task.Settings.Enabled; state = [string]$task.State }
  }
  foreach ($path in @(Get-AlfredStartupShortcuts)) {
    $sources += [pscustomobject]@{ kind = 'startup-folder'; enabled = $true; state = 'Registered' }
  }
  $active = @($sources | Where-Object { $_.enabled })
  $state = if ($active.Count -gt 0) {
    if (@($active | Where-Object { $_.kind -eq 'startup-folder' }).Count -gt 0) { 'Startup folder' } else { [string]$task.State }
  } elseif ($sources.Count -gt 0) { 'Disabled' } else { 'missing' }
  [pscustomobject]@{
    taskName = $TaskName
    registered = $sources.Count -gt 0
    enabled = $active.Count -gt 0
    state = $state
    trigger = if ($active.Count -gt 0) { 'Sign-in' } else { '' }
    sources = @($sources)
  }
}
