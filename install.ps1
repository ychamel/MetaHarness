# MetaHarness installer for Windows (PowerShell):
#   irm https://raw.githubusercontent.com/ychamel/MetaHarness/main/install.ps1 | iex
# Clones MetaHarness (to $env:MH_DIR, default ~\metaharness), installs it, builds the web app,
# puts `mh` on your PATH and runs `mh doctor`. It never installs Node or git for you: it says how.
$ErrorActionPreference = 'Stop'

$dir = if ($env:MH_DIR) { $env:MH_DIR } else { Join-Path $HOME 'metaharness' }
$repo = if ($env:MH_REPO) { $env:MH_REPO } else { 'https://github.com/ychamel/MetaHarness.git' }

function Fail($text) { Write-Host ''; Write-Host "X $text" -ForegroundColor Red; exit 1 }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "git isn't installed. Install it with: winget install Git.Git  (then open a new PowerShell window)" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node isn't installed. MetaHarness needs Node 24 or newer: winget install OpenJS.NodeJS  (then open a new PowerShell window)" }
$major = [int](node -p 'process.versions.node.split(".")[0]')
if ($major -lt 24) { Fail "Node $(node -v) is too old: MetaHarness needs 24 or newer. Update it: winget upgrade OpenJS.NodeJS" }

if (Test-Path (Join-Path $dir '.git')) {
  Write-Host "Updating MetaHarness in $dir"
  git -C $dir pull --ff-only
} else {
  Write-Host "Downloading MetaHarness to $dir"
  git clone --depth 1 $repo $dir
}
if ($LASTEXITCODE -ne 0) { Fail 'git could not download MetaHarness.' }
Set-Location $dir
Write-Host 'Installing (this takes a minute)'
npm install --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { Fail 'npm install failed; see the messages above.' }
npm run ui:build
if ($LASTEXITCODE -ne 0) { Fail 'Building the web app failed; see the messages above.' }
npm link *> $null
if ($LASTEXITCODE -ne 0) { Write-Host "Couldn't put mh on your PATH (npm link). Use: node $dir\src\cli.ts instead of mh." }

Write-Host ''
Write-Host "Checking what's here:"
Write-Host ''
node src/cli.ts doctor
Write-Host ''
Write-Host 'Installed. Start it with:  mh daemon' -ForegroundColor Green
Write-Host '  then open the app with:  mh ui'
