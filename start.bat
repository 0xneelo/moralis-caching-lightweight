@echo off
setlocal

cd /d "%~dp0"

echo.
echo ========================================
echo   Moralis Charting Local Launcher
echo ========================================
echo.

call "%~dp0stop-dev.bat"
echo.

if not exist "moralisCacheSystem\package.json" (
  echo Could not find moralisCacheSystem\package.json
  pause
  exit /b 1
)

cd moralisCacheSystem

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$envPath = Join-Path (Get-Location) '.env'; $adminLine = 'ADMIN_API_KEY=local-admin-key'; if (-not (Test-Path $envPath)) { Set-Content -Path $envPath -Value $adminLine -Encoding utf8; Write-Host 'Created .env with a local ADMIN_API_KEY.' } else { $content = Get-Content -Path $envPath -Raw; if ($content -notmatch '(?m)^\s*ADMIN_API_KEY\s*=') { Add-Content -Path $envPath -Value ''; Add-Content -Path $envPath -Value $adminLine; Write-Host 'Added local ADMIN_API_KEY to .env.' } }"
if errorlevel 1 (
  echo Failed to prepare local ADMIN_API_KEY.
  pause
  exit /b 1
)

where docker >nul 2>nul
if errorlevel 1 (
  echo Docker was not found. Starting no-Docker local memory mode.
  echo.
  echo Frontend will open at the Vite URL printed below, usually:
  echo   http://localhost:5173
  echo.
  call npm run dev:local
  pause
  exit /b %errorlevel%
)

echo Docker found. Starting Redis/Postgres containers...
docker compose up -d redis postgres
if errorlevel 1 (
  echo Docker startup failed. Falling back to no-Docker local memory mode.
  echo.
  call npm run dev:local
  pause
  exit /b %errorlevel%
)

echo Running database migrations...
call npm run migrate
if errorlevel 1 (
  echo Migration failed. Falling back to no-Docker local memory mode.
  echo.
  call npm run dev:local
  pause
  exit /b %errorlevel%
)

echo Preparing local Moralis-compatible X-API-Key...
call npm run local:api-key
if errorlevel 1 (
  echo Failed to prepare local Moralis-compatible API key.
  pause
  exit /b %errorlevel%
)

echo Starting API, worker, and frontend...
echo Admin API key for local admin routes: local-admin-key
echo.
call npm run dev:all
pause
