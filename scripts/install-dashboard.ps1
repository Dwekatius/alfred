# Compatibility entry point. Alfred now has one desktop shortcut.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'install-shortcut.ps1')
