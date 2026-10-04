# Pair the owner's private Telegram chat (local code + local acceptance).
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
$configPath = if ($env:PI_TG_CONFIG) { $env:PI_TG_CONFIG } else { Join-Path $env:USERPROFILE '.pi\alfred\config.json' }
node (Join-Path $ProjectRoot 'dist\src\pair-local.js') --config $configPath @args
exit $LASTEXITCODE
