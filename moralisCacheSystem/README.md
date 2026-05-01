# Moralis Cache System

Backend OHLC cache service for reducing Moralis chart costs.

The service stores historical candles in TimescaleDB/Postgres, uses Redis for hot cache/locks/rate limits, calls Moralis only for missing ranges, and queues large backfills through BullMQ.

## What This Solves

The frontend must not call Moralis directly. Users should call this service:

```text
Frontend -> /api/charts/ohlcv -> Redis/DB -> Moralis only for missing ranges
```

This prevents repeated full-history OHLC requests when users open charts or switch timeframes.

## Requirements

- Node.js 22+
- Docker Desktop
- Moralis API key in `.env`

## Environment

You already added `.env`. It should contain at least:

```env
MORALIS_API_KEY=your-key
DATABASE_URL=postgres://postgres:postgres@localhost:5432/moralis_cache
REDIS_URL=redis://localhost:6379
PORT=3001
ADMIN_API_KEY=change-me
```

Do not expose `MORALIS_API_KEY` to frontend env vars.

## Setup

Fastest start from the parent folder:

```powershell
.\start.bat
```

PowerShell alternative:

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

Bash/macOS/Linux:

```bash
./start.sh
```

The launcher installs dependencies if needed. If Docker is available, it starts Redis/Postgres, runs migrations, then starts API, worker, and frontend. If Docker is not available, it automatically starts no-Docker local memory mode.

```bash
npm install
docker compose up -d
npm run migrate
```

## No-Docker Local Mode

If Docker is not installed, use local memory mode:

```bash
npm run dev:local
```

From the parent folder, this also works:

```bash
npm run dev
```

This starts:

- a local in-memory API on `http://localhost:3001`
- the frontend on `http://localhost:5173`

Local memory mode does not require Redis or Postgres. It still calls Moralis for missing candles and keeps fetched candles only in process memory. Use this for UI/testing only, not production.

If `npm run dev:all` prints `ECONNREFUSED 127.0.0.1:6379`, Redis is not running. Start the local services first:

```bash
docker compose up -d postgres redis
```

Or use the helper:

```bash
npm run dev:docker
```

If Docker is not installed, install Redis/Postgres locally or point `REDIS_URL` and `DATABASE_URL` at hosted instances.

Run the API:

```bash
npm run dev
```

Run the worker in a second terminal:

```bash
npm run dev:worker
```

Run the trading test frontend in a third terminal:

```bash
npm run dev:frontend
```

Or run API, worker, and frontend together:

```bash
npm run dev:all
```

Open:

```text
http://localhost:5173
```

The frontend defaults to the Base pair:

```text
0x3eB2a8015dE1419a5089dAb37b0056F0fc24f821
```

## Logs

The API and worker log to both the terminal and a file:

```text
logs/app.log
```

Change the path with:

```env
LOG_FILE=logs/app.log
```

## API

### Health

```http
GET /health
```

### Get Chart Candles

```http
GET /api/charts/ohlcv?chain=eth&pairAddress=0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640&timeframe=1h&currency=usd&from=2026-04-01T00:00:00.000Z&to=2026-04-28T00:00:00.000Z
```

Response:

```json
{
  "chain": "eth",
  "pairAddress": "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
  "timeframe": "1h",
  "currency": "usd",
  "from": "2026-04-01T00:00:00.000Z",
  "to": "2026-04-28T00:00:00.000Z",
  "source": "cache+moralis",
  "partial": false,
  "candles": []
}
```

### Moralis-Compatible OHLCV

External frontends can point their Moralis-style client at this service and keep the same OHLCV request syntax. They only need to change the base URL and use one of the generated API keys:

```http
GET /api/v2.2/pairs/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/ohlcv?chain=eth&timeframe=1h&currency=usd&fromDate=2026-04-01T00:00:00.000Z&toDate=2026-04-28T00:00:00.000Z&limit=1000
X-API-Key: mcs_live_generated_key
```

Solana-compatible path:

```http
GET /token/mainnet/pairs/PAIR_ADDRESS/ohlcv?timeframe=1h&currency=usd&fromDate=2026-04-01T00:00:00.000Z&toDate=2026-04-28T00:00:00.000Z&limit=1000
X-API-Key: mcs_live_generated_key
```

Response:

```json
{
  "cursor": null,
  "result": [
    {
      "timestamp": "2026-04-01T00:00:00.000Z",
      "open": 1.23,
      "high": 1.3,
      "low": 1.2,
      "close": 1.25,
      "volume": 12000.5,
      "trades": 42
    }
  ]
}
```

### Queue Admin Backfill

```http
POST /api/admin/charts/backfill
Authorization: Bearer change-me
Content-Type: application/json
```

```json
{
  "chain": "eth",
  "pairAddress": "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
  "timeframes": ["1min", "5min", "1h"],
  "currency": "usd",
  "from": "2026-04-01T00:00:00.000Z",
  "to": "2026-04-28T00:00:00.000Z",
  "priority": "normal"
}
```

### Disable Moralis Provider

```http
POST /api/admin/moralis/enabled
Authorization: Bearer change-me
Content-Type: application/json
```

```json
{
  "enabled": false
}
```

### Manage External API Keys

Create a key:

```http
POST /api/admin/api-keys
Authorization: Bearer change-me
Content-Type: application/json
```

```json
{
  "name": "partner frontend"
}
```

The raw `apiKey` is returned only when created. Store it securely and give that value to the external frontend as its `X-API-Key`.

List keys:

```http
GET /api/admin/api-keys
Authorization: Bearer change-me
```

Revoke a key:

```http
DELETE /api/admin/api-keys/:id
Authorization: Bearer change-me
```

## Cost Controls

- Max synchronous Moralis pages defaults to `3`.
- Large gaps are queued instead of fetched synchronously.
- Redis locks dedupe concurrent provider fetches.
- Chart requests are rate-limited by user/IP.
- Provider cache misses are rate-limited separately.
- Estimated Moralis CUs are logged in `provider_api_usage`.
- Daily CU budget guard defaults to `5,000,000`.

## Useful Commands

Typecheck:

```bash
npm run typecheck
npm run typecheck:frontend
```

Tests:

```bash
npm test
```

Full E2E with migrations:

```bash
npm run test:e2e:full
```

This runs typecheck, the E2E migration SQL smoke test, the E2E HTTP route test, and a production build. It does not require Docker.

Full E2E against a real database:

```bash
npm run test:e2e:real
```

This runs `npm run migrate` against the real `DATABASE_URL`, then the E2E HTTP route test. It requires a reachable Postgres/TimescaleDB instance.

Queue active pair refresh jobs:

```bash
npm run schedule
```

## Production Notes

- Run API and worker as separate processes.
- Put `.env` values in a real secret manager.
- Keep `ADMIN_API_KEY` private.
- Use HTTPS and normal auth in front of admin routes.
- Set dashboard alerts on `provider_api_usage.estimated_cu`.
- Keep Dexscreener fallback available until this service is proven stable.
