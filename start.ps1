$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

Write-Host ""
Write-Host "========================================"
Write-Host "  Moralis Charting Local Launcher"
Write-Host "========================================"
Write-Host ""

& "$PSScriptRoot/stop-dev.ps1"
Write-Host ""

if (-not (Test-Path "moralisCacheSystem/package.json")) {
  Write-Host "Could not find moralisCacheSystem/package.json" -ForegroundColor Red
  exit 1
}

Set-Location "moralisCacheSystem"

if (-not (Test-Path "node_modules")) {
  Write-Host "Installing dependencies..." -ForegroundColor Cyan
  npm install
}

$docker = Get-Command docker -ErrorAction SilentlyContinue

if (-not $docker) {
  Write-Host "Docker was not found. Starting no-Docker local memory mode." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Frontend will open at the Vite URL printed below, usually:" -ForegroundColor Cyan
  Write-Host "  http://localhost:5173" -ForegroundColor Cyan
  Write-Host ""
  npm run dev:local
  exit $LASTEXITCODE
}

try {
  Write-Host "Docker found. Starting Redis/Postgres containers..." -ForegroundColor Cyan
  docker compose up -d redis postgres

  Write-Host "Running database migrations..." -ForegroundColor Cyan
  npm run migrate

  Write-Host "Starting API, worker, and frontend..." -ForegroundColor Cyan
  npm run dev:all
} catch {
  Write-Host ""
  Write-Host "Docker or migration startup failed. Falling back to no-Docker local memory mode." -ForegroundColor Yellow
  Write-Host $_.Exception.Message -ForegroundColor DarkYellow
  Write-Host ""
  npm run dev:local
  exit $LASTEXITCODE
}
