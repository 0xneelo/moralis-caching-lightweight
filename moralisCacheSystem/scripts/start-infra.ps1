$ErrorActionPreference = "Stop"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host ""
  Write-Host "Docker is not installed or not available in PATH." -ForegroundColor Yellow
  Write-Host "Use no-Docker local mode instead:" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "  npm run dev:local" -ForegroundColor Cyan
  Write-Host ""
  exit 1
}

docker compose up -d redis postgres
