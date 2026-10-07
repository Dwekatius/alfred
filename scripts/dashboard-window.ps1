# Opens the local dashboard in a clean app window, starting the dashboard
# server first when it is not already running.
param([string]$Page = '', [string]$Theme = '', [string]$ConfigPath = '')
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not $ConfigPath) {
  $ConfigPath = if ($env:PI_TG_CONFIG) { $env:PI_TG_CONFIG } else { Join-Path $env:USERPROFILE '.pi\alfred\config.json' }
}

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$stateDir = Join-Path $config.dataRoot 'state'
$infoPath = Join-Path $stateDir 'dashboard.json'

function Test-Dashboard([int]$Port) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

# A browser can own several windows, so MainWindowTitle alone cannot find the app.
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class AlfredDashboardWindow {
  private delegate bool WindowCallback(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
  public static bool ShowExisting() {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr window, IntPtr parameter) {
      if (!IsWindowVisible(window)) return true;
      var text = new StringBuilder(512);
      GetWindowText(window, text, text.Capacity);
      var title = text.ToString();
      if (title != "Alfred" && !title.StartsWith("Alfred - ") && !title.StartsWith("Alfred \u2014 ")) return true;
      uint processId;
      GetWindowThreadProcessId(window, out processId);
      try {
        var process = Process.GetProcessById((int)processId);
        using (process) {
          var name = process.ProcessName.ToLowerInvariant();
          if (name != "chrome" && name != "msedge" && name != "firefox") return true;
        }
      } catch { return true; }
      found = window;
      return false;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) return false;
    if (IsIconic(found)) ShowWindow(found, 9);
    SetForegroundWindow(found);
    return true;
  }
}
'@

# Serialize shortcut/controller launches until the server and window are ready.
$hash = [System.Security.Cryptography.SHA256]::Create()
try { $digest = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($config.dataRoot.ToLowerInvariant()))).Replace('-', '') }
finally { $hash.Dispose() }
$mutex = [Threading.Mutex]::new($false, "Local\AlfredDashboard-$digest")
$owned = $false
try {
  try { $owned = $mutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $owned = $true }
  if (-not $owned) { throw 'Another dashboard launch is still in progress.' }

  $port = if ($env:PI_TG_DASHBOARD_PORT) { [int]$env:PI_TG_DASHBOARD_PORT } else { 8787 }
  if (Test-Path -LiteralPath $infoPath) {
    try { $port = (Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json).port } catch { }
  }
  if (-not (Test-Dashboard $port)) {
    $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    if (-not $node) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
    if (-not $node) { throw 'Node.js was not found on PATH.' }
    # Start-Process joins its arguments. Quote the config path explicitly.
    Start-Process -FilePath $node -ArgumentList "dist\src\dashboard.js --config `"$ConfigPath`" --port $port" -WorkingDirectory $ProjectRoot -WindowStyle Hidden
    for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
      Start-Sleep -Milliseconds 500
      if (Test-Dashboard $port) { break }
    }
    if (-not (Test-Dashboard $port)) { throw 'Dashboard did not start; check the logs folder.' }
  }

  # Explicit setup/settings links may request another page; automatic opens reuse it.
  if (-not $Page -and -not $Theme -and [AlfredDashboardWindow]::ShowExisting()) { return }
  $info = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json
  $url = "http://127.0.0.1:$($info.port)/?token=$($info.token)"
  if ($Theme) { $url += "&theme=$Theme" }
  if ($Page) { $url += "#$Page" }

  $chrome = $config.browser.executablePath
  if (-not (Test-Path -LiteralPath $chrome)) { $chrome = Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe' }
  if (Test-Path -LiteralPath $chrome) {
    Start-Process -FilePath $chrome -ArgumentList @("--app=$url", '--window-size=1520,980', '--new-window')
  } else {
    Start-Process $url
  }
  # Keep simultaneous launches from creating two windows during Chrome startup.
  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    if ([AlfredDashboardWindow]::ShowExisting()) { break }
    Start-Sleep -Milliseconds 100
  }
} finally {
  if ($owned) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
