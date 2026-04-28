#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo ""
echo "========================================"
echo "  Moralis Charting Local Launcher"
echo "========================================"
echo ""

if command -v lsof >/dev/null 2>&1; then
  for port in 3001 5173 5174; do
    pid="$(lsof -ti tcp:$port || true)"
    if [ -n "$pid" ]; then
      echo "Stopping process on port $port ($pid)"
      kill -9 $pid || true
    fi
  done
fi

if [ ! -f "moralisCacheSystem/package.json" ]; then
  echo "Could not find moralisCacheSystem/package.json"
  exit 1
fi

cd moralisCacheSystem

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker was not found. Starting no-Docker local memory mode."
  echo ""
  echo "Frontend will open at the Vite URL printed below, usually:"
  echo "  http://localhost:5173"
  echo ""
  npm run dev:local
  exit $?
fi

if docker compose up -d redis postgres; then
  echo "Running database migrations..."
  if npm run migrate; then
    echo "Starting API, worker, and frontend..."
    npm run dev:all
  else
    echo "Migration failed. Falling back to no-Docker local memory mode."
    npm run dev:local
  fi
else
  echo "Docker startup failed. Falling back to no-Docker local memory mode."
  npm run dev:local
fi
