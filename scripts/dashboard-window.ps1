# Opens the local dashboard in a clean app window, starting the dashboard
# server first when it is not already running.
param([string]$Page = '', [string]$Theme = '')
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ConfigPath = if ($env:PI_TG_CONFIG) { $env:PI_TG_CONFIG } else { Join-Path $env:USERPROFILE '.pi\alfred\config.json' }

$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$stateDir = Join-Path $config.dataRoot 'state'
$infoPath = Join-Path $stateDir 'dashboard.json'

$port = 8787
if (Test-Path $infoPath) {
  try { $port = (Get-Content $infoPath -Raw | ConvertFrom-Json).port } catch { }
}

function Test-Dashboard([int]$Port) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

if (-not (Test-Dashboard $port)) {
  $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $node) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
  if (-not $node) { throw 'Node.js was not found on PATH.' }
  # Relative script path + explicit working directory keeps paths with spaces safe.
  Start-Process -FilePath $node -ArgumentList @(
    'dist\src\dashboard.js',
    '--config', $ConfigPath,
    '--port', "$port"
  ) -WorkingDirectory $ProjectRoot -WindowStyle Hidden
  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    Start-Sleep -Milliseconds 500
    if (Test-Dashboard $port) { break }
  }
  if (-not (Test-Dashboard $port)) { throw 'Dashboard did not start; check the logs folder.' }
}

$info = Get-Content $infoPath -Raw | ConvertFrom-Json
$url = "http://127.0.0.1:$($info.port)/?token=$($info.token)"
if ($Theme) { $url += "&theme=$Theme" }
if ($Page) { $url += "#$Page" }

$chrome = $config.browser.executablePath
if (-not (Test-Path $chrome)) {
  $chrome = Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'
}
if (Test-Path $chrome) {
  Start-Process -FilePath $chrome -ArgumentList @("--app=$url", '--window-size=1520,980', '--new-window')
} else {
  Start-Process $url
}
