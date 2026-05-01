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

function Ensure-LocalAdminApiKey {
  $envPath = Join-Path (Get-Location) ".env"
  $adminLine = "ADMIN_API_KEY=local-admin-key"

  if (-not (Test-Path $envPath)) {
    Set-Content -Path $envPath -Value $adminLine -Encoding utf8
    Write-Host "Created .env with a local ADMIN_API_KEY." -ForegroundColor Cyan
    return
  }

  $content = Get-Content -Path $envPath -Raw

  if ($content -notmatch "(?m)^\s*ADMIN_API_KEY\s*=") {
    Add-Content -Path $envPath -Value ""
    Add-Content -Path $envPath -Value $adminLine
    Write-Host "Added local ADMIN_API_KEY to .env." -ForegroundColor Cyan
  }
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
  Ensure-LocalAdminApiKey

  Write-Host "Docker found. Starting Redis/Postgres containers..." -ForegroundColor Cyan
  docker compose up -d redis postgres
  if ($LASTEXITCODE -ne 0) {
    throw "Docker containers failed to start. Is Docker Desktop running?"
  }

  Write-Host "Running database migrations..." -ForegroundColor Cyan
  npm run migrate
  if ($LASTEXITCODE -ne 0) {
    throw "Database migrations failed."
  }

  Write-Host "Preparing local Moralis-compatible X-API-Key..." -ForegroundColor Cyan
  npm run local:api-key
  if ($LASTEXITCODE -ne 0) {
    throw "Local Moralis-compatible API key setup failed."
  }

  Write-Host "Starting API, worker, and frontend..." -ForegroundColor Cyan
  Write-Host "Admin API key for local admin routes: local-admin-key" -ForegroundColor Cyan
  npm run dev:all
  exit $LASTEXITCODE
} catch {
  Write-Host ""
  Write-Host "Docker or migration startup failed. Falling back to no-Docker local memory mode." -ForegroundColor Yellow
  Write-Host $_.Exception.Message -ForegroundColor DarkYellow
  Write-Host ""
  npm run dev:local
  exit $LASTEXITCODE
}
