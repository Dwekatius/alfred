# Compatibility entry point for the single Alfred shortcut installer.
param([switch]$Startup)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'install-shortcut.ps1') -Startup:$Startup
