#!/usr/bin/env pwsh
# Prepare the self-contained workbench engine (engine-pi/) before `tauri build`.
#
# Copies this build machine's node.exe + the globally-installed pi package
# (@earendil-works/pi-coding-agent, incl. its node_modules) into engine-pi/,
# which Tauri then packs into the installer (bundle.resources -> engine-pi/**).
#
# Usage:  pwsh scripts/prepare-engine-pi.ps1
#
# If pi is not installed globally:  npm i -g @earendil-works/pi-coding-agent

$ErrorActionPreference = 'Stop'

$root      = Split-Path -Parent $PSScriptRoot
$engineDir = Join-Path $root 'engine-pi'
$piDst     = Join-Path $engineDir 'pi'

Write-Host "[prepare-engine-pi] target: $engineDir"

# 1) node.exe -------------------------------------------------------------
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node not found on PATH. Install Node.js first." }
Write-Host "[prepare-engine-pi] node: $node"
New-Item -ItemType Directory -Force -Path $engineDir | Out-Null
Copy-Item -Path $node -Destination (Join-Path $engineDir 'node.exe') -Force

# 2) pi package (dist + node_modules + package.json) ----------------------
# Global npm root on Windows is %APPDATA%\npm\node_modules.
$candidates = @()
if ($env:APPDATA) {
  $candidates += Join-Path $env:APPDATA 'npm\node_modules\@earendil-works\pi-coding-agent'
}
try { $candidates += Join-Path (npm root -g) '@earendil-works\pi-coding-agent' } catch {}

$piSrc = $candidates | Where-Object { Test-Path (Join-Path $_ 'dist\cli.js') } | Select-Object -First 1
if (-not $piSrc) {
  throw "pi not found globally. Run: npm i -g @earendil-works/pi-coding-agent"
}
Write-Host "[prepare-engine-pi] pi source: $piSrc"

if (Test-Path $piDst) { Remove-Item -Recurse -Force $piDst }
New-Item -ItemType Directory -Force -Path $piDst | Out-Null
Copy-Item -Path (Join-Path $piSrc 'dist')         -Destination (Join-Path $piDst 'dist') -Recurse -Force
Copy-Item -Path (Join-Path $piSrc 'node_modules') -Destination (Join-Path $piDst 'node_modules') -Recurse -Force
Copy-Item -Path (Join-Path $piSrc 'package.json') -Destination (Join-Path $piDst 'package.json') -Force
$shrink = Join-Path $piSrc 'npm-shrinkwrap.json'
if (Test-Path $shrink) { Copy-Item -Path $shrink -Destination (Join-Path $piDst 'npm-shrinkwrap.json') -Force }

# 3) self-check ------------------------------------------------------------
$ver = & (Join-Path $engineDir 'node.exe') (Join-Path $piDst 'dist\cli.js') --version
Write-Host "[prepare-engine-pi] bundled pi --version => $ver"
Write-Host "[prepare-engine-pi] done. engine-pi ready for tauri build."
