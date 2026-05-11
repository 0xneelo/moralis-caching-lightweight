# Moralis Charting Repository Specification

This specification is derived from the current implementation in this repository and focuses on how OHLC caching works and how data is served through the API.

## 1) Repository Scope

The workspace consists of:

- Root orchestration scripts and docs (`start.ps1`, `start.sh`, `start.bat`, `specs`, `docs`)
- Main service in `moralisCacheSystem`:
  - Fastify API
  - Redis cache + locks + rate limits
  - Postgres/Timescale persistence
  - BullMQ backfill worker
  - React test frontend

Primary goal: **cache-first OHLC serving** so frontend and external consumers do not repeatedly hit Moralis for historical ranges.

## 2) High-Level Architecture

Request path:

1. Frontend (or external client) calls API route.
2. API normalizes timeframe/range and enforces limits.
3. API checks Redis response cache (short TTL hot cache).
4. If needed, API reads persistent candles from Postgres.
5. Missing/suspicious gaps are fetched from Moralis under budget + rate controls.
6. New candles are upserted into Postgres.
7. Response is assembled, optionally forward-filled for visual continuity.
8. Non-partial responses are cached in Redis.

Async path:

- Large or expensive ranges are queued to BullMQ.
- Worker fetches from Moralis and writes back to Postgres.

## 3) Runtime Components

### 3.1 API server (`src/index.ts`, `src/server.ts`)

- Registers routes:
  - `GET /health`
  - `GET /api/charts/ohlcv`
  - Moralis-compatible:
    - `GET /api/v2.2/pairs/:pairAddress/ohlcv`
    - `GET /token/mainnet/pairs/:pairAddress/ohlcv`
  - `GET /api/usage/moralis`
  - `POST /api/debug/interactions`
  - Admin:
    - `POST /api/admin/charts/backfill`
    - `POST /api/admin/moralis/enabled`
    - `POST /api/admin/api-keys`
    - `GET /api/admin/api-keys`
    - `DELETE /api/admin/api-keys/:id`

### 3.2 Worker (`src/worker.ts`, `src/jobs/backfillWorker.ts`)

- Consumes `ohlcv-backfill` queue.
- Fetches large ranges from Moralis.
- Upserts candles, logs usage, updates history state.

### 3.3 Redis (`src/redis.ts`)

Used for:

- JSON response cache
- Gap-fetch distributed locks
- Rate-limit counters
- Feature flag (`feature:moralis_ohlcv_enabled`)

### 3.4 Postgres/Timescale (`src/db.ts`, migrations)

Persistent stores:

- `ohlcv_candles`
- `market_history_state`
- `provider_api_usage`
- `ohlcv_backfill_jobs`
- `chart_pairs`
- `external_api_keys`

## 4) Data Model

### 4.1 `ohlcv_candles`

- PK: `(chain, pair_address, timeframe, currency, timestamp)`
- Stores normalized OHLCV/trades candles.
- Main persistent candle cache.

### 4.2 `market_history_state`

- PK: `(chain, pair_address, timeframe, currency)`
- Tracks:
  - `history_floor_ts`
  - `market_start_ts`
  - `latest_synced_ts`
  - `full_history_status` (`unknown|queued|running|complete|failed`)
  - full-history job metadata/error

### 4.3 `provider_api_usage`

- Audits Moralis usage:
  - endpoint, pair/range, pages, estimated CU, latency, status
  - optional `external_api_key_id`

### 4.4 `ohlcv_backfill_jobs`

- Tracks async job lifecycle and outcomes.

### 4.5 `external_api_keys`

- Stores hashed API keys for compatibility routes.
- Enforces scopes (`ohlcv:read`).

### 4.6 `chart_pairs`

- Tracks request activity and hot pair eligibility.

## 5) Caching Strategy

### 5.1 Layer A: Postgres candle cache (long-lived)

- Queried for every chart request window.
- Filled by:
  - synchronous on-demand gap fetches
  - async backfill worker jobs

### 5.2 Layer B: Redis response cache (hot, short-lived)

Built in `buildChartCacheKey()`:

- Key: `chart:ohlcv:v5:<chain>:<pair>:<timeframe>:<currency>:<alignedFrom>:<alignedTo>`
- `from` is floored, `to` is ceiled to timeframe boundary for key reuse.

TTL policy (`getChartCacheTtl`):

- `1s`, `10s`, `30s`: 5s
- `1min`: 15s
- `5min`, `10min`: 30s
- `30min`, `1h`: 60s
- others: 300s

Important behavior:

- Partial responses are never written to response cache.
- Cache hits are returned as source `cache` (even if original write was `cache+moralis`).

### 5.3 Layer C: Response-time fill candles

- Missing intervals between real candles are forward-filled for chart continuity.
- Filled candles are tagged `source: filled`.
- Not persisted as real market candles.

## 6) `/api/charts/ohlcv` Lifecycle (Core Cache Logic)

Implemented in `getOhlcvForChart()` (`src/services/chartService.ts`).

1. Validate and normalize:
   - pair normalization
   - range limit check (`assertChartRangeAllowed`)
   - adaptive timeframe already passed in from route layer
2. Enforce chart rate limit:
   - actor (user/IP) and actor+pair windows
3. Touch pair in `chart_pairs`.
4. Load history state from `market_history_state`.
5. Detect full-history request (from `2024-01-01` to near-now).
6. Optionally enqueue initial full-history backfill if needed.
7. Check Redis response cache:
   - return immediately on safe cache hit.
8. Read stored candles from DB for request window.
9. Detect gap ranges:
   - true missing slots (`findMissingRanges`)
   - suspicious OHLC ranges (selected higher TFs)
10. Merge and prioritize gaps by visible range overlap/distance.
11. Provider protection:
   - enforce miss rate limits
   - if gap too large (`MAX_SYNC_GAP_CANDLES`), enqueue async backfill and mark partial
12. Synchronous gap fetch loop:
   - per-gap Redis lock dedupe
   - fetch Moralis with bounded pages/fetches
   - upsert candles + bounds
   - log provider usage
13. Re-read candles and assemble response.
14. If full history achieved non-partial, mark `market_history_state` complete.
15. Cache final response in Redis only when `partial=false`.

## 7) Gap Handling Details

### 7.1 Missing ranges

- Timeframe-step scan from aligned `from` to `to`.
- Any absent slot creates/extends a gap.
- Adjacent gaps merge.

### 7.2 Suspicious ranges

- Enabled for `1h`, `4h`, `6h`, `12h`, `1d`.
- Detects suspect OHLC quality and requests targeted refetch.

### 7.3 Visible-first prioritization

- Gaps inside current viewport are fetched first.
- Remaining gaps ordered by proximity to viewport.

## 8) Moralis Integration Behavior

### 8.1 Base behavior

- Provider key from `MORALIS_API_KEY`.
- Global provider feature gate:
  - config `CHART_PROVIDER_ENABLED`
  - Redis `feature:moralis_ohlcv_enabled`
- Estimated CU model: `150 CU/page`.
- Daily global CU budget enforced before fetch.
- Default sync page cap: `MAX_SYNC_MORALIS_PAGES` (default 3).

### 8.2 Solana-specific logic

- For larger TFs (`1h`,`4h`,`6h`,`12h`,`1d`):
  - fetches `5min` and aggregates up.
- If empty, may retry from Dexscreener `pairCreatedAt` (day-aligned).

### 8.3 Logging and usage accounting

- Logs provider calls and page outcomes.
- Persists usage to `provider_api_usage` for both internal and external API-key traffic.

## 9) Rate Limiting and Budgets

From `src/rateLimit.ts`:

- Chart request limit:
  - `120/min` per actor
  - `60/min` per actor+pair
- Provider miss limit:
  - `10/min` per actor
- External key request limit:
  - `EXTERNAL_API_KEY_REQUEST_RATE_LIMIT` (default 600/min)
- External key miss limit:
  - `EXTERNAL_API_KEY_CACHE_MISS_RATE_LIMIT` (default 20/min)
- External key daily CU budget:
  - `EXTERNAL_API_KEY_DAILY_CU_BUDGET` (default 100,000)

Global CU limit:

- `MORALIS_DAILY_CU_BUDGET` (default 5,000,000)

## 10) Distributed Locking

Gap fetch lock (`withRedisLock`, `buildGapFetchLockKey`):

- Key includes chain/pair/timeframe/currency/from/to.
- Prevents duplicate concurrent fetches of same gap.
- Lock TTL: 30s in sync chart path.

If lock not acquired:

- Request does not block; that fetch result is skipped and response may become partial.

## 11) Async Backfill Queue

### 11.1 Enqueue path

- `enqueueBackfillJob()`:
  - Inserts job in `ohlcv_backfill_jobs`
  - Adds BullMQ job with dedupe `jobId`
  - Updates DB row with queue job id

Reasons include:

- `admin`
- `user_gap`
- `active_refresh`
- `initial_history_load`

### 11.2 Worker execution

Worker flow:

1. Mark DB job running.
2. Mark history running for `initial_history_load`.
3. Fetch Moralis (worker uses `maxPages:100`).
4. Upsert candles and history bounds.
5. Log provider usage.
6. Mark job completed/failed.
7. Mark history complete or failed based on truncation/outcome.

### 11.3 Scheduled refresh

- `npm run schedule` enqueues high-priority refresh jobs for hot pairs.
- Window: last 2 hours at `1min`.

## 12) Moralis-Compatible API Serving

Compatibility routes do not bypass cache logic. They wrap the same chart service:

1. Authenticate `X-API-Key`.
2. Enforce key-specific request/miss controls.
3. Determine effective timeframe and paged window (`limit`, `cursor`).
4. Call `getOhlcvForChart()` for that page.
5. Transform chart candles to Moralis result format.
6. Return Moralis-style cursor + compatibility headers.

Headers expose source and CU delta to consumers (`x-cache-source`, `x-moralis-cu-used`, etc.).

## 13) Timeframe Adaptation

Both frontend and backend adapt timeframe to keep request sizes sane.

Backend (`timeframes.ts`):

- Minimum timeframe by span:
  - <=1d: `1min`
  - <=7d: `5min`
  - <=30d: `30min`
  - <=90d: `1h`
  - <=365d: `4h`
  - else: `12h`

Request guard:

- `assertChartRangeAllowed()` rejects windows exceeding `maxSyncCandlesByTimeframe`.

Frontend (`client/src/api.ts`):

- Computes effective timeframe, chunks oversized windows, prioritizes visible chunks first.

## 14) Local-Memory Mode (No Docker)

Defined in `src/localIndex.ts`:

- Uses in-memory maps for candle/response state.
- Uses local files for external key and usage accounting.
- Supports same core API shapes as standard mode.
- Can return synthetic demo candles when Moralis key is absent.
- Includes local cooldown + active fetch guards to avoid provider overuse.

This mode is for development convenience, not production.

## 15) Operational/Deployment Notes

- API and worker should run as separate processes in real deployment.
- `ADMIN_API_KEY` is required for admin routes.
- Migrations support plain Postgres and optional Timescale hypertable enablement.
- Health endpoint checks both DB and Redis in standard mode.

## 16) Current Implementation Characteristics

1. Full-history state tracking is active (`market_history_state`), but daily-bootstrap blocking is currently disabled in chart flow (`requiresDailyBootstrap = false`).
2. Partial responses are intentionally uncached at response-cache layer.
3. Source tagging distinguishes `cache`, `moralis`, `filled`, and (local mode) `demo`.
4. CU accounting is estimated from page counts, not provider-returned billing metadata.

## 17) End-to-End Summary

The repository implements a production-oriented cache-first OHLC proxy:

- Persistent DB candle cache minimizes repeated upstream pulls.
- Redis hot cache reduces repeated identical window requests.
- Gap detection + lock + budget/rate controls safely gate Moralis calls.
- Worker backfills handle large windows asynchronously.
- Moralis-compatible routes reuse the exact same caching core.
- Local-memory mode provides a practical offline/dev fallback with similar contract semantics.
