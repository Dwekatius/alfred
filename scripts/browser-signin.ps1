# Opens the dedicated Chrome profile so the owner can sign in to Gmail and other
# sites once. Close the window when done so the agent can own the profile.
$root = Join-Path $env:USERPROFILE '.pi\alfred'
$profile = Join-Path $root 'browser\profile'
New-Item -ItemType Directory -Force -Path $profile | Out-Null
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path $chrome)) {
  $chrome = (Get-Command chrome.exe -ErrorAction SilentlyContinue).Source
}
if (-not $chrome) { throw 'Chrome was not found.' }
Write-Host "Opening the dedicated agent profile at $profile"
Write-Host 'Sign in to Gmail/other sites, then CLOSE this Chrome window before browser tasks run.'
Start-Process -FilePath $chrome -ArgumentList @("--user-data-dir=$profile", '--no-first-run', '--new-window', 'https://accounts.google.com/')
