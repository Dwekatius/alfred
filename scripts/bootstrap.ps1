# One-click first-run setup for a fresh copy of the project.
# Installs dependencies, builds, starts the local dashboard, and opens the
# Setup guide. Safe to run again at any time.
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

Write-Host ''
Write-Host '===========================================' -ForegroundColor Cyan
Write-Host '  Alfred - one-click setup' -ForegroundColor Cyan
Write-Host '===========================================' -ForegroundColor Cyan
Write-Host ''

# -- 1. Node.js ------------------------------------------------------------
$node = (Get-Command node.exe -ErrorAction SilentlyContinue)
if (-not $node) { $node = (Get-Command node -ErrorAction SilentlyContinue) }
if (-not $node) {
  Write-Host '[X] Node.js was not found.' -ForegroundColor Red
  Write-Host '    Install Node.js 24 LTS from https://nodejs.org/ (default options),'
  Write-Host '    close this window, then run Setup Alfred.cmd again.'
  exit 1
}
$nodeVersion = (& $node.Source --version).TrimStart('v')
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 20) {
  Write-Host "[X] Node.js $nodeVersion is too old; install Node.js 24 LTS from https://nodejs.org/." -ForegroundColor Red
  exit 1
}
Write-Host "[ok] Node.js $nodeVersion" -ForegroundColor Green

# -- 2. npm dependencies ---------------------------------------------------
if (-not (Test-Path (Join-Path $ProjectRoot 'node_modules'))) {
  Write-Host '[..] Installing JavaScript dependencies (first run, a few minutes)...' -ForegroundColor Yellow
  & npm ci
  if ($LASTEXITCODE -ne 0) { Write-Host '[X] npm ci failed.' -ForegroundColor Red; exit 1 }
} else {
  Write-Host '[ok] JavaScript dependencies present' -ForegroundColor Green
}

# -- 3. Python virtual environment ----------------------------------------
$venvPython = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
if (-not (Test-Path $venvPython)) {
  $python = $null
  foreach ($candidate in @('py', 'python')) {
    $command = Get-Command $candidate -ErrorAction SilentlyContinue
    if (-not $command) { continue }
    try {
      $version = & $command.Source --version 2>&1
      if ($version -match '3\.1[0-9]') { $python = $command.Source; break }
    } catch { }
  }
  if (-not $python) {
    Write-Host '[X] Python 3.10+ was not found.' -ForegroundColor Red
    Write-Host '    Install Python from https://www.python.org/downloads/ and tick'
    Write-Host '    "Add python.exe to PATH", then run this setup again.'
    exit 1
  }
  Write-Host '[..] Creating the Python environment (first run)...' -ForegroundColor Yellow
  & $python -m venv (Join-Path $ProjectRoot '.venv')
  if ($LASTEXITCODE -ne 0) { Write-Host '[X] Could not create .venv.' -ForegroundColor Red; exit 1 }
  & $venvPython -m pip install --upgrade pip --quiet
  & $venvPython -m pip install -r (Join-Path $ProjectRoot 'python\requirements.lock.txt') --quiet
  if ($LASTEXITCODE -ne 0) { Write-Host '[X] Could not install Python dependencies.' -ForegroundColor Red; exit 1 }
} else {
  Write-Host '[ok] Python environment present' -ForegroundColor Green
}

# -- 4. Build --------------------------------------------------------------
Write-Host '[..] Building the application...' -ForegroundColor Yellow
& npm run build --silent
if ($LASTEXITCODE -ne 0) { Write-Host '[X] Build failed.' -ForegroundColor Red; exit 1 }
Write-Host '[ok] Build complete' -ForegroundColor Green

# -- 5. Dashboard + setup guide -------------------------------------------
Write-Host '[..] Installing the Alfred desktop shortcut...' -ForegroundColor Yellow
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ProjectRoot 'scripts\install-shortcut.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Could not install the Alfred shortcut.' }
Write-Host '[..] Starting the local dashboard...' -ForegroundColor Yellow
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ProjectRoot 'scripts\dashboard-window.ps1') -Page setup
Write-Host ''
Write-Host 'The setup guide is open in the app window. Follow steps 1-6.' -ForegroundColor Cyan
Write-Host 'You can close this console after the guide is open.' -ForegroundColor Cyan
Write-Host ''
