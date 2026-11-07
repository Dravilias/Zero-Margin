# Installs Zero Margin for the current user on Windows. No administrator rights needed.
gi#   powershell -ExecutionPolicy Bypass -File install.ps1             install the newest package in release\
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall  remove the game (saves and settings are kept)
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'

$appDir = Join-Path $env:LOCALAPPDATA 'Programs\ZeroMargin'
$appFile = Join-Path $appDir 'ZeroMargin.exe'
$programs = [Environment]::GetFolderPath('Programs')
$shortcutFile = Join-Path $programs 'Zero Margin.lnk'

if ($Uninstall) {
  Remove-Item -LiteralPath $shortcutFile -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $appDir -Recurse -ErrorAction SilentlyContinue
  Write-Host 'Zero Margin is uninstalled. Your saves and settings were kept.'
  exit 0
}

$package = Get-ChildItem -Path (Join-Path $PSScriptRoot 'release') -Filter 'ZeroMargin-*-win-*.exe' -ErrorAction SilentlyContinue |
  Sort-Object { [version]($_.Name -replace '^ZeroMargin-([0-9.]+)-.*$', '$1') } |
  Select-Object -Last 1

if (-not $package) {
  Write-Error 'No Windows package found in release\. Download one, or build it with: npm ci, then npm run dist:win'
}

New-Item -ItemType Directory -Force -Path $appDir | Out-Null
Copy-Item -LiteralPath $package.FullName -Destination $appFile -Force

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutFile)
$shortcut.TargetPath = $appFile
$shortcut.WorkingDirectory = $appDir
$shortcut.Description = 'Zero Margin'
$shortcut.Save()

Write-Host "Installed $($package.Name). Find Zero Margin in your Start menu."
Write-Host 'The game is not code-signed, so Windows may warn you the first time: choose More info, then Run anyway.'
