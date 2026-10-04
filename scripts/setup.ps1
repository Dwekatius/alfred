# Alfred setup (run once per user).
# Creates the Python virtual environment, installs pinned dependencies, copies
# the example configuration, builds the TypeScript app, and runs doctor.
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

Write-Host "Project root: $ProjectRoot"

$nodeVersion = (& node --version).TrimStart('v')
if (-not ($nodeVersion -like '24.*')) {
  Write-Warning "Node.js $nodeVersion found; the pinned runtime is 24.15.x."
} else {
  Write-Host "Node.js $nodeVersion OK"
}

$python = $null
foreach ($candidate in @('py -3.14', 'python')) {
  try {
    $parts = $candidate.Split(' ')
    $exe = $parts[0]
    $args = @($parts[1..($parts.Length - 1)]) + @('-c', 'import sys; print(sys.version_info[:2])')
    $result = & $exe @args 2>$null
    if ($LASTEXITCODE -eq 0 -and $result -match '3,\s*14') { $python = $candidate; break }
  } catch { }
}
if (-not $python) { throw 'Python 3.14 was not found. Install it or add it to PATH.' }
Write-Host "Python: $python"

$venvPython = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
if (-not (Test-Path $venvPython)) {
  Write-Host 'Creating .venv ...'
  $parts = $python.Split(' ')
  & $parts[0] @($parts[1..($parts.Length - 1)]) -m venv (Join-Path $ProjectRoot '.venv')
}
& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install -r (Join-Path $ProjectRoot 'python\requirements.lock.txt')
& $venvPython -c "import importlib.metadata as m; print('windows-mcp', m.version('windows-mcp'))"

Write-Host 'Installing npm dependencies from the lockfile ...'
npm ci

$dataRoot = Join-Path $env:USERPROFILE '.pi\alfred'
New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
foreach ($sub in @('secrets','agent','state','sessions','artifacts','browser\profile','browser\output','logs','manifests','work')) {
  New-Item -ItemType Directory -Force -Path (Join-Path $dataRoot $sub) | Out-Null
}
$configPath = Join-Path $dataRoot 'config.json'
if (-not (Test-Path $configPath)) {
  Copy-Item (Join-Path $ProjectRoot 'config.example.json') $configPath -Force
  Write-Host "Copied example configuration to $configPath - review it before starting."
}

Write-Host 'Building TypeScript ...'
npm run build

Write-Host ''
Write-Host 'Setup complete. Next steps:'
Write-Host "  1. Review $configPath"
Write-Host '  2. npm run doctor'
Write-Host '  3. npm run pair        (provide the BotFather token locally, then accept the chat)'
Write-Host '  4. npm run start       (or npm run install-startup for logon startup)'
