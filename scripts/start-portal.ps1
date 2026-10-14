# Launch the God's Eye View portal: start the Vite dev server, wait for it to
# answer, then open the default browser at the portal URL. Closing this window
# stops the server.

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$port = 4173
$url  = "http://localhost:$port"

$Host.UI.RawUI.WindowTitle = "God's Eye View - portal (port $port)"

Write-Host ""
Write-Host "  God's Eye View" -ForegroundColor Cyan
Write-Host "  $repo" -ForegroundColor DarkGray
Write-Host ""

# Fail early with a readable message rather than a raw npm error.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "  Node.js was not found on PATH. Install Node 24.14+ and retry." -ForegroundColor Red
    Read-Host "  Press Enter to close"
    exit 1
}
Write-Host "  node $(node --version)" -ForegroundColor DarkGray

if (-not (Test-Path (Join-Path $repo 'node_modules'))) {
    Write-Host "  node_modules missing - running npm install (one time)..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  npm install failed." -ForegroundColor Red
        Read-Host "  Press Enter to close"
        exit 1
    }
}

# CCTV source pack. The compiled default is Austin, which leaves the camera
# layer empty everywhere else - the app opens over the Lower Mainland, so load
# the repo's Pacific Northwest pack (1180 keyless public feeds, 807 of them in
# Vancouver and the Tri-Cities) instead. This is what scripts/dev-pnw.sh does on
# macOS/Linux; mirrored here because that script is bash. The 900-source default
# would silently truncate the 1180-camera pack, hence the raised ceiling.
# Override either value before launching to pick a different pack.
if (-not $env:CCTV_SOURCES_FILE) { $env:CCTV_SOURCES_FILE = 'config/cctv_sources.pnw.json' }
if (-not $env:CCTV_MAX_SOURCES) { $env:CCTV_MAX_SOURCES = '1200' }
Write-Host "  cctv  $($env:CCTV_SOURCES_FILE)" -ForegroundColor DarkGray

# If the port is already serving, reuse that server instead of starting a second.
$alreadyUp = $false
try {
    $probe = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
    if ($probe.StatusCode -ge 200) { $alreadyUp = $true }
} catch { }

if ($alreadyUp) {
    Write-Host "  Server already running on port $port - opening browser." -ForegroundColor Green
    Start-Process $url
    exit 0
}

Write-Host "  Starting dev server on $url ..." -ForegroundColor Green
Write-Host "  Keep this window open. Close it (or press Ctrl+C) to stop the server." -ForegroundColor DarkGray
Write-Host ""

# Start the server in this window so its log stays visible and closing the
# window takes the server with it.
$server = Start-Process -FilePath 'npm.cmd' -ArgumentList 'run', 'dev' -NoNewWindow -PassThru

# Poll until Vite answers, then open the browser once.
$opened = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    if ($server.HasExited) {
        Write-Host ""
        Write-Host "  The dev server exited before it came up (exit $($server.ExitCode))." -ForegroundColor Red
        Read-Host "  Press Enter to close"
        exit 1
    }
    try {
        $probe = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
        if ($probe.StatusCode -ge 200) { $opened = $true; break }
    } catch { }
}

if ($opened) {
    Write-Host ""
    Write-Host "  Portal is up - opening $url" -ForegroundColor Green
    Start-Process $url
} else {
    Write-Host ""
    Write-Host "  Server did not answer within 30s. Open $url manually once it does." -ForegroundColor Yellow
}

# Hold the window so the server keeps running and its output stays readable.
$server.WaitForExit()
