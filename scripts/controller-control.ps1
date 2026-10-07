# Shared controller controls. Dot-source after setting $ProjectRoot and $ConfigPath.
# Manual launch works independently of the optional sign-in scheduled task.
$TaskName = 'Alfred'

function Get-DataRoot {
  try {
    $cfg = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    if ($cfg.dataRoot) { return $cfg.dataRoot }
  } catch { }
  return (Join-Path $env:USERPROFILE '.pi\alfred')
}

function Read-IpcInfo {
  $infoPath = Join-Path (Get-DataRoot) 'state\local-ipc.json'
  if (-not (Test-Path -LiteralPath $infoPath)) { return $null }
  try { return Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json } catch { return $null }
}

function Invoke-LocalIpc([string]$Command, [int]$TimeoutMs = 3000) {
  $info = Read-IpcInfo
  if (-not $info) { return $null }
  $pipeName = $info.pipeName -replace '^\\\\\.\\pipe\\', ''
  $pipe = $null
  try {
    $pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
    $pipe.Connect($TimeoutMs)
    $writer = New-Object System.IO.StreamWriter($pipe)
    $writer.AutoFlush = $true
    $reader = New-Object System.IO.StreamReader($pipe)
    $writer.WriteLine((@{ token = $info.token; command = $Command } | ConvertTo-Json -Compress))
    $line = $reader.ReadLine()
    if (-not $line) { return $null }
    return $line | ConvertFrom-Json
  } catch {
    return $null
  } finally {
    if ($pipe) { $pipe.Dispose() }
  }
}

function Get-AgentStatus {
  $lockPath = Join-Path (Get-DataRoot) 'state\controller.lock'
  $infoPath = Join-Path (Get-DataRoot) 'state\local-ipc.json'
  if (-not (Test-Path -LiteralPath $lockPath) -or -not (Test-Path -LiteralPath $infoPath)) { return $null }
  $response = Invoke-LocalIpc 'status' 800
  if ($response -and $response.ok) { return $response.result }
  return $null
}

function Open-Dashboard {
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $script = Join-Path $ProjectRoot 'scripts\dashboard-window.ps1'
  try {
    Start-Process -FilePath $powershell -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`" -ConfigPath `"$ConfigPath`"" -WorkingDirectory $ProjectRoot -WindowStyle Hidden -ErrorAction Stop | Out-Null
  } catch {
    Write-Warning 'Could not open the dashboard. Use the dashboard shortcut or tray menu.'
  }
}

function Start-Agent {
  if (Get-AgentStatus) { Open-Dashboard; return $true }
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  $startedTask = $false
  if ($task) {
    try {
      Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
      $startedTask = $true
    } catch {
      Write-Verbose 'The scheduled task could not be started; using a direct launch.'
    }
  }
  if (-not $startedTask) {
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $runner = Join-Path $ProjectRoot 'scripts\run-controller.ps1'
    try {
      # Start-Process joins ArgumentList into a command line, so quote both paths.
      $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runner`" -ConfigPath `"$ConfigPath`""
      Start-Process -FilePath $powershell -ArgumentList $arguments -WorkingDirectory $ProjectRoot -WindowStyle Hidden -ErrorAction Stop | Out-Null
    } catch {
      Write-Warning 'Could not launch the controller process.'
      return $false
    }
  }
  for ($i = 0; $i -lt 30; $i += 1) {
    Start-Sleep -Milliseconds 700
    if (Get-AgentStatus) { return $true }
  }
  return $false
}

function Stop-Agent {
  $status = Get-AgentStatus
  if ($status) {
    Invoke-LocalIpc 'shutdown' | Out-Null
    for ($i = 0; $i -lt 20; $i += 1) {
      Start-Sleep -Milliseconds 500
      if (-not (Get-AgentStatus)) { break }
    }
  } else {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }
}

function Restart-Agent {
  Stop-Agent
  Start-Sleep -Seconds 1
  return (Start-Agent)
}
