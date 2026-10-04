@echo off
title Alfred Setup
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\bootstrap.ps1"
if errorlevel 1 (
  echo.
  echo Setup did not finish. Read the messages above, fix the issue, and run this file again.
  pause
)
