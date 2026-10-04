# Stop the running controller through its authenticated local pipe.
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
$configPath = if ($env:PI_TG_CONFIG) { $env:PI_TG_CONFIG } else { Join-Path $env:USERPROFILE '.pi\alfred\config.json' }
node (Join-Path $ProjectRoot 'dist\src\local-cli.js') shutdown --config $configPath
exit $LASTEXITCODE
