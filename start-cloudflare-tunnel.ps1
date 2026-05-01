param(
  [switch]$PrintOnly
)

$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

$apiBaseUrl = "http://localhost:3001"
$systemPath = Join-Path $PSScriptRoot "moralisCacheSystem"
$keyPath = Join-Path $systemPath ".local-external-api-key"
$credentialsPath = Join-Path $PSScriptRoot "cloudflared-credentials.json"
$toolsPath = Join-Path $PSScriptRoot "tools"
$localCloudflaredPath = Join-Path $toolsPath "cloudflared.exe"
$cloudflaredDownloadUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"

function New-LocalExternalApiKey {
  $bytes = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $token = [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
  return "mcs_live_local_$token"
}

function Get-OrCreate-LocalExternalApiKey {
  if (Test-Path $keyPath) {
    $existing = (Get-Content -Path $keyPath -Raw).Trim()

    if ($existing) {
      return $existing
    }
  }

  $apiKey = New-LocalExternalApiKey
  Set-Content -Path $keyPath -Value $apiKey -Encoding utf8
  return $apiKey
}

function Get-CloudflaredCommand {
  $command = Get-Command cloudflared -ErrorAction SilentlyContinue

  if ($command) {
    return $command.Source
  }

  $candidates = @(
    "$env:LOCALAPPDATA\Microsoft\WindowsApps\cloudflared.exe",
    "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe",
    "$env:ProgramFiles\cloudflared\cloudflared.exe",
    "$env:ProgramFiles\Cloudflare\cloudflared.exe",
    $localCloudflaredPath
  )

  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }

  return $null
}

function Install-LocalCloudflaredFallback {
  New-Item -ItemType Directory -Force -Path $toolsPath | Out-Null

  Write-Host "cloudflared is installed by winget but not visible on PATH." -ForegroundColor Yellow
  Write-Host "Downloading local fallback:" -ForegroundColor Cyan
  Write-Host "  $localCloudflaredPath"
  Write-Host ""

  Invoke-WebRequest -Uri $cloudflaredDownloadUrl -OutFile $localCloudflaredPath
  return $localCloudflaredPath
}

function Write-CloudflaredCredentials {
  param(
    [string]$BaseUrl,
    [string]$ApiKey
  )

  $payload = [ordered]@{
    baseUrl = $BaseUrl
    apiKeyHeader = "X-API-Key"
    apiKey = $ApiKey
    localApiTarget = $apiBaseUrl
    moralisCompatiblePaths = @(
      "/api/v2.2/pairs/:pairAddress/ohlcv",
      "/token/mainnet/pairs/:pairAddress/ohlcv"
    )
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  }

  Set-Content -Path $credentialsPath -Value ($payload | ConvertTo-Json -Depth 4) -Encoding utf8
  Write-Host ""
  Write-Host "Wrote Cloudflare credentials:" -ForegroundColor Green
  Write-Host "  $credentialsPath"
  Write-Host ""
}

if (-not (Test-Path (Join-Path $systemPath "package.json"))) {
  Write-Host "Could not find moralisCacheSystem/package.json" -ForegroundColor Red
  exit 1
}

$apiKey = Get-OrCreate-LocalExternalApiKey

Write-Host ""
Write-Host "========================================"
Write-Host "  Cloudflare Tunnel Launcher"
Write-Host "========================================"
Write-Host ""
Write-Host "Local API target:" -ForegroundColor Cyan
Write-Host "  $apiBaseUrl"
Write-Host ""
Write-Host "Give your frontend partner this header:" -ForegroundColor Cyan
Write-Host "  X-API-Key: $apiKey"
Write-Host ""
Write-Host "Moralis-compatible paths:" -ForegroundColor Cyan
Write-Host "  /api/v2.2/pairs/:pairAddress/ohlcv"
Write-Host "  /token/mainnet/pairs/:pairAddress/ohlcv"
Write-Host ""
if ($PrintOnly) {
  Write-Host "PrintOnly mode enabled. Not starting cloudflared." -ForegroundColor Yellow
  exit 0
}

$cloudflared = Get-CloudflaredCommand

if (-not $cloudflared) {
  $cloudflared = Install-LocalCloudflaredFallback
}

Write-Host "Starting Cloudflare quick tunnel..." -ForegroundColor Cyan
Write-Host "Copy the https://*.trycloudflare.com URL printed by cloudflared." -ForegroundColor Yellow
Write-Host "Partner base URL will be that Cloudflare URL."
Write-Host ""

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"

try {
  & $cloudflared tunnel --url $apiBaseUrl 2>&1 | ForEach-Object {
    $line = $_.ToString()
    Write-Host $line

    if ($line -match "https://[a-zA-Z0-9-]+\.trycloudflare\.com") {
      Write-CloudflaredCredentials -BaseUrl $Matches[0] -ApiKey $apiKey
    }
  }
} finally {
  $ErrorActionPreference = $previousErrorActionPreference
}
