#!/usr/bin/env pwsh
# Prepare the bundled workbench codex engine (engine-codex/) before `tauri build`.
#
# Copies the ENTIRE npm codex vendor tree -- not just codex.exe. codex resolves
# its helper executables (codex-resources/codex-command-runner.exe,
# codex-resources/codex-windows-sandbox-setup.exe) relative to its own exe;
# shipping the bare exe makes any real exec/file-edit die with 0xC0000142
# (STATUS_DLL_INIT_FAILED). Layout staged here (mirrors the vendor):
#
#   engine-codex/
#     bin/codex.exe            <- what workbench.rs hands to --codex-exe
#     codex-resources/         <- command-runner + windows-sandbox-setup
#     codex-path/rg.exe
#     codex-package.json
#
# Usage:  pwsh scripts/prepare-engine-codex.ps1
#
# If codex is not installed globally:  npm i -g @openai/codex

$ErrorActionPreference = 'Stop'

$root      = Split-Path -Parent $PSScriptRoot
$engineDir = Join-Path $root 'engine-codex'

Write-Host "[prepare-engine-codex] target: $engineDir"

# Locate the npm global vendor tree (win-x64 native binary + resources).
$rel = 'node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc'
$candidates = @()
if ($env:APPDATA) { $candidates += Join-Path $env:APPDATA "npm\$rel" }
try {
  $npmRoot = (npm root -g).Trim()
  if ($npmRoot) { $candidates += Join-Path (Split-Path -Parent $npmRoot) $rel }
} catch {}

$src = $candidates | Where-Object {
  (Test-Path (Join-Path $_ 'bin\codex.exe')) -and
  (Test-Path (Join-Path $_ 'codex-resources\codex-command-runner.exe'))
} | Select-Object -First 1
if (-not $src) {
  throw "codex vendor tree (bin\codex.exe + codex-resources\) not found globally. Run: npm i -g @openai/codex"
}
Write-Host "[prepare-engine-codex] vendor source: $src"

# Stage a clean copy (whole tree, structure preserved).
if (Test-Path $engineDir) { Remove-Item -Recurse -Force $engineDir }
New-Item -ItemType Directory -Force -Path $engineDir | Out-Null
Copy-Item -Path (Join-Path $src '*') -Destination $engineDir -Recurse -Force

# Sanity: the pieces codex needs at runtime must all be present.
$must = @(
  'bin\codex.exe',
  'codex-resources\codex-command-runner.exe',
  'codex-resources\codex-windows-sandbox-setup.exe'
)
foreach ($m in $must) {
  if (-not (Test-Path (Join-Path $engineDir $m))) {
    throw "staging incomplete: missing $m"
  }
}

$ver  = & (Join-Path $engineDir 'bin\codex.exe') --version
$size = [math]::Round((Get-ChildItem $engineDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "[prepare-engine-codex] staged: $ver, $size MB total"
Write-Host "[prepare-engine-codex] done. tauri.conf.json bundles ../engine-codex -> resources/engine-codex/"
