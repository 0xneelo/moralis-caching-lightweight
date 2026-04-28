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

echo Starting API, worker, and frontend...
echo.
call npm run dev:all
pause
