# Run local diagnostics without printing secrets.
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
$configPath = if ($env:PI_TG_CONFIG) { $env:PI_TG_CONFIG } else { Join-Path $env:USERPROFILE '.pi\alfred\config.json' }
$extra = $args
node (Join-Path $ProjectRoot 'dist\src\doctor.js') --config $configPath @extra
exit $LASTEXITCODE
