# Alfred tray controller.
# One-click start/stop/status for the native Windows agent, plus a tray icon.
#
#   powershell -File scripts\tray.ps1                 # tray icon (starts the agent if stopped)
#   powershell -File scripts\tray.ps1 -Action status  # headless status JSON
#   powershell -File scripts\tray.ps1 -Action start|stop|restart|pause|resume
param(
  [ValidateSet('tray','status','start','stop','restart','pause','resume')]
  [string]$Action = 'tray',
  [switch]$NoAutoStart
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ConfigPath = if ($env:PI_TG_CONFIG) { $env:PI_TG_CONFIG } else { Join-Path $env:USERPROFILE '.pi\alfred\config.json' }
. (Join-Path $PSScriptRoot 'controller-control.ps1')

function New-TrayIcon([System.Drawing.Color]$Color) {
  $bitmap = New-Object System.Drawing.Bitmap 32, 32
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $logoPath = Join-Path $ProjectRoot 'resources\logo.png'
  if (Test-Path $logoPath) {
    # Project logo with a small status dot in the corner.
    $logo = [System.Drawing.Image]::FromFile($logoPath)
    $graphics.DrawImage($logo, 3, 4, 26, 26)
    $logo.Dispose()
    $ring = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    $dot = New-Object System.Drawing.SolidBrush $Color
    $graphics.FillEllipse($ring, 16, 16, 16, 16)
    $graphics.FillEllipse($dot, 19, 19, 10, 10)
    $ring.Dispose()
    $dot.Dispose()
  } else {
    $brush = New-Object System.Drawing.SolidBrush $Color
    $graphics.FillEllipse($brush, 3, 3, 26, 26)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 3
    $graphics.DrawEllipse($pen, 3, 3, 26, 26)
    $brush.Dispose()
    $pen.Dispose()
  }
  $graphics.Dispose()
  $handle = $bitmap.GetHicon()
  # The bitmap must stay alive for the icon's lifetime; it is kept in $script:iconBitmaps.
  $script:iconBitmaps += $bitmap
  return [System.Drawing.Icon]::FromHandle($handle)
}

# Created once and reused by the refresh timer (no per-tick GDI churn).
$script:iconBitmaps = @()
$icons = @{
  stopped   = New-TrayIcon ([System.Drawing.Color]::Gray)
  running   = New-TrayIcon ([System.Drawing.Color]::LimeGreen)
  busy      = New-TrayIcon ([System.Drawing.Color]::DodgerBlue)
  attention = New-TrayIcon ([System.Drawing.Color]::Orange)
}

function Get-StatusSummary([object]$Status) {
  if (-not $Status) { return 'Agent is stopped.' }
  if ($Status.stopping) { return 'Agent is stopping...' }
  if ($Status.activeJob) { return "Working on $($Status.activeJob.id): $($Status.activeJob.label)" }
  if ($Status.queued -gt 0) { return "Idle; $($Status.queued) queued" }
  if ($Status.dispatchSuspended) { return 'Idle; dispatch suspended (/run-next)' }
  return 'Running and idle.'
}

# Headless actions for scripting/diagnostics.
if ($Action -ne 'tray') {
  switch ($Action) {
    'status' { Get-AgentStatus | ConvertTo-Json -Depth 6; exit 0 }
    'start' { if (Start-Agent) { 'started' } else { 'failed to start'; exit 1 } ; exit 0 }
    'stop' { Stop-Agent; 'stopped'; exit 0 }
    'restart' { if (Restart-Agent) { 'restarted'; exit 0 } else { 'failed to restart'; exit 1 } }
    'pause' { Invoke-LocalIpc 'pause' | ConvertTo-Json -Depth 6; exit 0 }
    'resume' { Invoke-LocalIpc 'resume' | ConvertTo-Json -Depth 6; exit 0 }
  }
}

# ---------------------------------------------------------------- tray mode

# Reopening the desktop shortcut starts the agent but keeps one tray icon.
$trayHash = [System.Security.Cryptography.SHA256]::Create()
try {
  $trayDigest = [BitConverter]::ToString($trayHash.ComputeHash([Text.Encoding]::UTF8.GetBytes((Get-DataRoot).ToLowerInvariant()))).Replace('-', '')
} finally { $trayHash.Dispose() }
$createdTray = $false
$trayMutex = [System.Threading.Mutex]::new($true, "Local\AlfredTray-$trayDigest", [ref]$createdTray)
if (-not $createdTray) {
  try { if (-not $NoAutoStart) { Start-Agent | Out-Null } } finally { $trayMutex.Dispose() }
  exit 0
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Text = 'Alfred'
$notify.Icon = $icons.stopped
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = $menu.Items.Add('Status: starting...')
$statusItem.Enabled = $false
$null = $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$startItem = $menu.Items.Add('Start agent')
$startItem.Add_Click({ Start-Agent | Out-Null; Update-Tray })
$stopItem = $menu.Items.Add('Stop agent (graceful)')
$stopItem.Add_Click({ Stop-Agent; Update-Tray })
$restartItem = $menu.Items.Add('Restart agent')
$restartItem.Add_Click({ Restart-Agent | Out-Null; Update-Tray })
$pauseItem = $menu.Items.Add('Pause active job')
$pauseItem.Add_Click({ Invoke-LocalIpc 'pause' | Out-Null; Update-Tray })
$resumeItem = $menu.Items.Add('Resume active job')
$resumeItem.Add_Click({ Invoke-LocalIpc 'resume' | Out-Null; Update-Tray })
$null = $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$screenshotItem = $menu.Items.Add('Open logs folder')
$screenshotItem.Add_Click({ Start-Process explorer.exe (Join-Path (Get-DataRoot) 'logs') })
$configItem = $menu.Items.Add('Open config')
$configItem.Add_Click({ Start-Process notepad.exe $ConfigPath })
$doctorItem = $menu.Items.Add('Run doctor')
$doctorItem.Add_Click({ $script = Join-Path $ProjectRoot 'scripts\doctor.ps1'; Start-Process powershell.exe -ArgumentList "-NoExit -NoProfile -ExecutionPolicy Bypass -File `"$script`"" })
$dashboardItem = $menu.Items.Add('Open dashboard')
$dashboardItem.Add_Click({ $script = Join-Path $ProjectRoot 'scripts\dashboard-window.ps1'; Start-Process powershell.exe -ArgumentList "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`"" })
$pairItem = $menu.Items.Add('Pairing window')
$pairItem.Add_Click({ $script = Join-Path $ProjectRoot 'scripts\pair-window.ps1'; Start-Process powershell.exe -ArgumentList "-NoExit -NoProfile -ExecutionPolicy Bypass -File `"$script`"" })
$null = $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$exitItem = $menu.Items.Add('Exit tray')
$context = New-Object System.Windows.Forms.ApplicationContext
$exitItem.Add_Click({ $notify.Visible = $false; $notify.Dispose(); $context.ExitThread() })

function Update-Tray {
  $status = Get-AgentStatus
  $state = 'stopped'
  $icon = $icons.stopped
  if ($status) {
    if ($status.stopping) { $icon = $icons.attention; $state = 'stopping' }
    elseif ($status.activeJob) { $icon = $icons.busy; $state = 'busy' }
    elseif ($status.dispatchSuspended) { $icon = $icons.attention; $state = 'suspended' }
    else { $icon = $icons.running; $state = 'running' }
  }
  $summary = Get-StatusSummary $status
  $notify.Icon = $icon
  $notify.Text = ("Alfred - " + $state)
  $statusItem.Text = ("Status: " + $state + " - " + $summary)
  $startItem.Enabled = -not $status
  $stopItem.Enabled = [bool]$status
  $restartItem.Enabled = [bool]$status
  $pauseItem.Enabled = [bool]($status -and $status.activeJob)
  $resumeItem.Enabled = [bool]($status -and $status.activeJob)
}

$notify.ContextMenuStrip = $menu
$notify.Add_DoubleClick({ Start-Agent | Out-Null; Update-Tray })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({ Update-Tray })
$timer.Start()

Update-Tray
if (-not $NoAutoStart) {
  $existing = Get-AgentStatus
  if (-not $existing) {
    if (Start-Agent) {
      $notify.ShowBalloonTip(4000, 'Alfred', 'Agent started. Message your bot in Telegram.', [System.Windows.Forms.ToolTipIcon]::Info)
    } else {
      $notify.ShowBalloonTip(5000, 'Alfred', 'Could not start the agent. Right-click for logs and doctor.', [System.Windows.Forms.ToolTipIcon]::Warning)
    }
    Update-Tray
  }
}

try {
  [System.Windows.Forms.Application]::Run($context)
} finally {
  $timer.Stop()
  $notify.Dispose()
  $trayMutex.ReleaseMutex()
  $trayMutex.Dispose()
}
