# Moralis OHLC Cache - Overview and Architecture

## Purpose

This project prevents uncontrolled Moralis OHLC spend by moving chart data behind our backend, storing historical candles, and calling Moralis only for missing ranges.

The immediate production risk is that chart users can repeatedly trigger expensive Moralis OHLC requests by opening many charts or switching timeframes. A malicious or curious beta user can create real overage if Moralis calls are reachable from the browser or if backend calls are not cached and bounded.

## Current Problem

Current behavior described by the team:

- The app does not aggregate candles internally.
- If a user requests `1M`, Moralis returns `1M` candles.
- If the user switches to `1min`, the app queries Moralis again.
- If the user switches to `5min`, the app queries Moralis again.
- If the user switches back to `1min`, the app queries Moralis again.

Moralis billing nuance:

- Moralis does not bill directly per candle.
- The OHLC endpoint costs `150 CUs` per API call.
- Large ranges paginate.
- If `limit=1000`, then one year of `1min` candles is about `525,600` candles, which is roughly `526` API calls.
- `526 * 150 CUs = 78,900 CUs` for one full one-year `1min` backfill.

On Pro overage:

```text
$75/day overage / $5 per 1M CUs = 15M extra CUs/day
15M CUs / 150 CUs per OHLC call = ~100,000 extra OHLC calls/day
15M CUs/day * 30 days = 450M extra CUs/month
```

Switching to Business can reduce immediate pain, but it does not fix the architecture.

## Target Architecture

```text
Browser
  |
  | GET /api/charts/ohlcv?chain=eth&pairAddress=0x...&timeframe=1min&from=...&to=...
  v
Backend Chart API
  |
  | 1. Validate request and enforce range limits
  | 2. Check Redis response cache
  | 3. Query TimescaleDB/Postgres for stored candles
  | 4. Detect missing ranges
  | 5. Fetch only safe missing ranges from Moralis
  | 6. Upsert candles into TimescaleDB/Postgres
  | 7. Return normalized candle response
  v
Frontend Chart
```

## Component Responsibilities

### Frontend

- Calls our backend only.
- Never calls `deep-index.moralis.io`.
- Never receives the Moralis API key.
- Requests only visible chart ranges.
- Keeps a small in-memory cache when users switch timeframes.
- Handles `partial=true` responses while background backfills complete.

### Backend Chart API

- Owns the chart data contract.
- Validates chain, pair, timeframe, `from`, and `to`.
- Rejects unbounded historical requests.
- Enforces per-user and per-IP rate limits.
- Checks Redis and database before Moralis.
- Returns sorted candles in a chart-friendly format.

### TimescaleDB/Postgres

- Durable source of truth for fetched historical candles.
- Enforces uniqueness by `chain`, `pair_address`, `timeframe`, `currency`, and `timestamp`.
- Supports fast range queries.
- Optionally supports continuous aggregates for higher timeframe candles.

### Redis

- Hot response cache.
- Distributed locks to dedupe concurrent Moralis fetches.
- Rate limiting counters.
- Feature flags and circuit breaker state.

### Background Workers

- Refresh hot pairs.
- Backfill missing historical ranges.
- Repair gaps daily.
- Respect daily CU budgets.
- Keep user requests from triggering huge synchronous provider calls.

### Moralis Provider Adapter

- Backend-only.
- Adds the API key server-side.
- Handles pagination with strict limits.
- Logs estimated CU usage.
- Returns normalized candle objects.

## Data Ownership Rules

- Frontend never calls Moralis.
- Frontend never receives `MORALIS_API_KEY`.
- TimescaleDB/Postgres is the durable store.
- Redis is not the durable source of truth.
- Moralis is a provider of missing data, not the runtime chart database.
- User requests can trigger only bounded fetches.
- Heavy backfills must go through a queue.

## Recommended Stack

```text
Primary database:
  TimescaleDB/Postgres

Hot cache and locks:
  Redis

Queue:
  BullMQ if the backend is Node.js
  Temporal if the team already uses it
  Existing job system if one exists

Temporary chart fallback:
  Dexscreener embed/chart

Provider:
  Moralis OHLCV endpoint
```

## Project Goals

Immediate goals:

- Stop uncontrolled Moralis spend.
- Remove direct browser Moralis usage.
- Rotate any exposed Moralis API key.
- Use Dexscreener or a bounded backend route while the cache is built.
- Add request limits.

Permanent goals:

- Store all fetched OHLC candles.
- Serve from backend storage whenever possible.
- Fetch only missing ranges from Moralis.
- Refresh active pairs automatically.
- Backfill cold pairs through controlled jobs.
- Aggregate higher timeframes internally where practical.
- Track Moralis usage by endpoint, pair, timeframe, user, and day.

## Non-Goals

- Replacing Moralis entirely in phase 1.
- Rebuilding raw DEX indexing from blockchain logs immediately.
- Letting user requests synchronously backfill unlimited history.
- Loading full `1min` history on initial chart load.

## Default Product Policy

```text
Initial visible range:
  1min: last 24h
  5min: last 7d
  1h: last 30d
  1d: last 1y

Max synchronous Moralis pages:
  3

Backfill behavior:
  Queue large missing ranges
  Return partial data if needed

Hot pair refresh:
  Every 1-5 minutes for active pairs

Cold pair behavior:
  Serve recent range first
  Queue deeper history
```

## Success Criteria

- Moralis dashboard usage drops immediately after emergency cutoff.
- Browser network tab shows no Moralis calls.
- Identical chart request does not call Moralis twice.
- Timeframe switching reuses cache/database.
- Concurrent requests for the same missing range dedupe into one provider fetch.
- Large `1min` ranges are queued, not fetched synchronously.
- Daily CU budget guard can pause provider calls.
- Operators can disable Moralis OHLC instantly with a feature flag.
