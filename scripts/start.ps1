# Start the controller in this terminal (visible logs on stderr/stdout).
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
$configPath = if ($env:PI_TG_CONFIG) { $env:PI_TG_CONFIG } else { Join-Path $env:USERPROFILE '.pi\alfred\config.json' }
node (Join-Path $ProjectRoot 'dist\src\main.js') --config $configPath @args
exit $LASTEXITCODE
