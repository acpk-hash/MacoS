#!/usr/bin/env pwsh
# Stage the self-contained pi runtime into engine-pi/ before `tauri build`.
#
# Layout (must match pi_rpc.rs resolve_node / resolve_pi_cli and
# tauri.conf.json bundle.resources { "../engine-pi": "engine-pi" }):
#   engine-pi/node.exe            <- this build machine's node.exe
#   engine-pi/pi/dist/cli.js      <- @earendil-works/pi-coding-agent dist
#   engine-pi/pi/node_modules/    <- the package's own deps (offline-complete)
#   engine-pi/pi/package.json
#
# Idempotent: wipes engine-pi/ first, then re-stages. Prunes maps / tests /
# docs to cut weight, then smoke-checks `node cli.js --version` with the
# staged runtime and prints the final size.
#
# Usage:  pwsh scripts/prepare-engine-pi.ps1
# If pi is missing:  npm i -g @earendil-works/pi-coding-agent

$ErrorActionPreference = 'Stop'

$root      = Split-Path -Parent $PSScriptRoot
$engineDir = Join-Path $root 'engine-pi'
$piDst     = Join-Path $engineDir 'pi'

Write-Host "[prepare-engine-pi] target: $engineDir"

# 0) idempotency: clean slate --------------------------------------------
if (Test-Path $engineDir) { Remove-Item -Recurse -Force $engineDir }
New-Item -ItemType Directory -Force -Path $engineDir | Out-Null

# 1) node.exe --------------------------------------------------------------
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found on PATH. Install Node.js first.' }
$nodeVer = & $node --version
Write-Host "[prepare-engine-pi] node: $node ($nodeVer)"
Copy-Item -Path $node -Destination (Join-Path $engineDir 'node.exe') -Force

# 2) locate the globally-installed pi package -------------------------------
$candidates = @()
if ($env:APPDATA) {
  $candidates += Join-Path $env:APPDATA 'npm\node_modules\@earendil-works\pi-coding-agent'
}
try {
  $npmRoot = (& npm root -g) 2>$null | Select-Object -First 1
  if ($npmRoot) { $candidates += Join-Path $npmRoot '@earendil-works\pi-coding-agent' }
} catch {}

$piSrc = $candidates | Where-Object { Test-Path (Join-Path $_ 'dist\cli.js') } | Select-Object -First 1
if (-not $piSrc) { throw 'pi not found globally. Run: npm i -g @earendil-works/pi-coding-agent' }
Write-Host "[prepare-engine-pi] pi source: $piSrc"

# 3) copy dist / package.json / node_modules --------------------------------
# The npm-published package carries its own node_modules (bundled deps), so
# copying that directory yields an offline-complete runtime. If a future npm
# ever hoists them into the global shared layer instead, fail loudly.
New-Item -ItemType Directory -Force -Path $piDst | Out-Null
Copy-Item -Path (Join-Path $piSrc 'dist') -Destination (Join-Path $piDst 'dist') -Recurse -Force
Copy-Item -Path (Join-Path $piSrc 'package.json') -Destination (Join-Path $piDst 'package.json') -Force

$nmSrc = Join-Path $piSrc 'node_modules'
if (Test-Path $nmSrc) {
  Copy-Item -Path $nmSrc -Destination (Join-Path $piDst 'node_modules') -Recurse -Force
} else {
  # Deps hoisted to the global shared layer: copy each package.json dependency
  # from the global node_modules root instead.
  Write-Host '[prepare-engine-pi] package has no own node_modules; copying deps from global root'
  $pkg = Get-Content (Join-Path $piSrc 'package.json') -Raw | ConvertFrom-Json
  if (-not $pkg.dependencies) { throw 'no node_modules and no dependencies list - cannot stage deps' }
  $globalNm = Split-Path -Parent (Split-Path -Parent $piSrc)   # ...\npm\node_modules
  $nmDst = Join-Path $piDst 'node_modules'
  New-Item -ItemType Directory -Force -Path $nmDst | Out-Null
  foreach ($dep in $pkg.dependencies.PSObject.Properties.Name) {
    $src = Join-Path $globalNm ($dep -replace '/', '\')
    if (-not (Test-Path $src)) { throw "dependency '$dep' not found under $globalNm" }
    $dst = Join-Path $nmDst ($dep -replace '/', '\')
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Copy-Item -Path $src -Destination $dst -Recurse -Force
  }
}

# 4) prune non-runtime weight ------------------------------------------------
# NOTE: keep this list conservative - e.g. the 'yaml' package ships a
# runtime 'doc/' directory; pruning generic 'doc'/'test' names breaks deps.
$pruneDirNames  = @('__tests__', '.github')
$pruneFileGlobs = @('*.map', '*.md', '*.markdown', '*.d.ts', '*.d.mts', '*.d.cts', '*.ts.map')

$dirsRemoved = 0
Get-ChildItem -Path $piDst -Recurse -Directory -Force |
  Where-Object { $pruneDirNames -contains $_.Name } |
  Sort-Object { $_.FullName.Length } -Descending |
  ForEach-Object {
    if (Test-Path $_.FullName) { Remove-Item -Recurse -Force $_.FullName; $dirsRemoved++ }
  }

$filesRemoved = 0
foreach ($glob in $pruneFileGlobs) {
  Get-ChildItem -Path $piDst -Recurse -File -Force -Filter $glob | ForEach-Object {
    Remove-Item -Force $_.FullName; $filesRemoved++
  }
}
Write-Host "[prepare-engine-pi] pruned: $dirsRemoved dirs, $filesRemoved files"

# 5) smoke-check with the STAGED runtime (not the host install) ---------------
$stagedNode = Join-Path $engineDir 'node.exe'
$stagedCli  = Join-Path $piDst 'dist\cli.js'
$ver = & $stagedNode $stagedCli --version
if ($LASTEXITCODE -ne 0) { throw "staged runtime smoke-check failed (exit $LASTEXITCODE)" }
Write-Host "[prepare-engine-pi] staged pi --version => $ver"

# 6) report size ---------------------------------------------------------------
$nodeMB  = [math]::Round((Get-Item $stagedNode).Length / 1MB, 1)
$piBytes = (Get-ChildItem -Path $piDst -Recurse -File -Force | Measure-Object -Sum Length).Sum
$piMB    = [math]::Round($piBytes / 1MB, 1)
Write-Host "[prepare-engine-pi] size: node.exe ${nodeMB} MB + pi/ ${piMB} MB = $([math]::Round($nodeMB + $piMB, 1)) MB"
Write-Host '[prepare-engine-pi] done. engine-pi ready for tauri build.'
