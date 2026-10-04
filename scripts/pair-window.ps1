# Opens an interactive window for the local pairing flow (token prompt + local acceptance).
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
$configPath = if ($env:PI_TG_CONFIG) { $env:PI_TG_CONFIG } else { Join-Path $env:USERPROFILE '.pi\alfred\config.json' }
Write-Host '=== Alfred pairing ==='
Write-Host 'Paste the BotFather token with hidden input when asked.'
Write-Host 'Then send /start <code> from the private chat in Telegram and accept locally here.'
Write-Host ''
node (Join-Path $ProjectRoot 'dist\src\pair-local.js') --config $configPath
Write-Host ''
Write-Host 'Pairing window finished. You can close this window.'
