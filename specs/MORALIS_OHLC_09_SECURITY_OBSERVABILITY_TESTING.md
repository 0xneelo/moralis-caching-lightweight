# Moralis OHLC Cache - Security, Observability, Rollout, and Testing

## Purpose

This document covers the operational controls needed to keep Moralis usage safe after the caching backend is deployed.

## Security Requirements

### Secret Handling

- Moralis key must exist only in backend secret manager.
- Never prefix the key with `NEXT_PUBLIC_`, `VITE_`, or any frontend-exposed env name.
- Rotate the key after any suspected exposure.
- Do not log request headers.
- Do not return provider errors that include secrets.
- Do not expose provider URLs as a frontend implementation detail.

### Key Rotation Checklist

```text
1. Create new Moralis API key.
2. Update backend secret manager.
3. Deploy backend.
4. Confirm backend can fetch Moralis.
5. Revoke old key.
6. Confirm frontend bundle does not contain old or new key.
7. Confirm browser network tab has no Moralis calls.
```

### Abuse Prevention

Add:

- Per-user rate limits.
- Per-IP rate limits.
- Per-pair request limits.
- Max date range per timeframe.
- Max synchronous Moralis pages.
- Daily Moralis CU budget.
- Circuit breaker to disable Moralis provider automatically.

## Circuit Breaker

```ts
export async function isMoralisEnabled() {
  const flag = await redis.get('feature:moralis_ohlcv_enabled');
  return flag !== 'false';
}

export async function assertMoralisEnabled() {
  if (!(await isMoralisEnabled())) {
    throw new Error('Moralis OHLC provider is disabled');
  }
}
```

## Observability Metrics

Track:

```text
chart_requests_total
chart_cache_hits_total
chart_cache_misses_total
ohlcv_db_query_duration_ms
ohlcv_missing_ranges_total
moralis_requests_total
moralis_estimated_cu_total
moralis_errors_total
moralis_429_total
backfill_jobs_queued
backfill_jobs_failed
backfill_jobs_completed
backfill_queue_lag_seconds
```

Dashboard views:

```text
CUs used today
CUs by endpoint
CUs by pair
CUs by timeframe
Top requesting users/IPs
Chart cache hit rate
Backfill queue status
Moralis error rate
Moralis 429 rate
```

## Usage Queries

Estimated CUs today:

```sql
SELECT
  provider,
  endpoint,
  sum(estimated_cu) AS estimated_cu
FROM provider_api_usage
WHERE created_at >= date_trunc('day', now())
GROUP BY provider, endpoint
ORDER BY estimated_cu DESC;
```

Top pairs by Moralis usage:

```sql
SELECT
  chain,
  pair_address,
  timeframe,
  sum(estimated_cu) AS estimated_cu,
  count(*) AS requests
FROM provider_api_usage
WHERE created_at >= now() - INTERVAL '24 hours'
GROUP BY chain, pair_address, timeframe
ORDER BY estimated_cu DESC
LIMIT 50;
```

Backfill failures:

```sql
SELECT
  chain,
  pair_address,
  timeframe,
  status,
  error_message,
  created_at
FROM ohlcv_backfill_jobs
WHERE status = 'failed'
ORDER BY created_at DESC
LIMIT 100;
```

## Alerts

Recommended alerts:

```text
Moralis estimated CU > daily budget threshold
Moralis 429 rate > 1% for 5 minutes
Moralis error rate > 5% for 5 minutes
Backfill queue lag > 15 minutes
Chart cache hit rate < 70% after warmup
Single user/IP causes > X cache misses/minute
Single pair causes unexpected provider spike
```

## Rollout Plan

### Phase 0: Emergency

Duration: same day.

Tasks:

- Disable Moralis direct chart calls.
- Use Dexscreener temporarily.
- Rotate API key if exposed.
- Deploy feature flag for Moralis OHLC provider.
- Add rough endpoint rate limits.

Acceptance:

- Browser network tab shows no Moralis calls.
- Moralis dashboard usage drops immediately.
- Charts still have fallback behavior.

### Phase 1: Backend Proxy

Duration: 1-2 days.

Tasks:

- Add `/api/charts/ohlcv`.
- Backend calls Moralis.
- Add request validation.
- Add rate limits.
- Add strict max pages.
- Add usage logging.

Acceptance:

- Frontend uses backend only.
- No frontend key.
- User cannot request unlimited history.

### Phase 2: Persistent Candle Store

Duration: 2-4 days.

Tasks:

- Add TimescaleDB schema.
- Upsert Moralis candles.
- Query DB before Moralis.
- Detect missing ranges.
- Add Redis response cache.
- Add distributed locks.

Acceptance:

- Repeated same chart request hits DB/cache.
- Re-clicking timeframe does not call Moralis again if data exists.
- Concurrent users dedupe same fetch.

### Phase 3: Backfill Jobs

Duration: 2-5 days.

Tasks:

- Add queue.
- Add active pair refresh.
- Add daily gap fill.
- Add admin backfill endpoint.
- Add daily CU budget guard.

Acceptance:

- Hot pairs are prefilled.
- Users rarely trigger Moralis synchronously.
- Backfills pause when CU budget is reached.

### Phase 4: Aggregation

Duration: 3-7 days.

Tasks:

- Aggregate higher timeframes from lower timeframe candles.
- Add continuous aggregates or app-level aggregation.
- Reduce provider calls for non-base timeframes.

Acceptance:

- Switching from `1min` to `5min`, `10min`, `30min`, or `1h` can be served internally when base data exists.
- Moralis calls per chart session drop significantly.

## Testing Plan

### Unit Tests

Test:

- Timeframe validation.
- Candle count estimation.
- Date alignment.
- Gap detection.
- Cache key generation.
- Rate limit behavior.
- Moralis pagination logic.
- Aggregation open/high/low/close correctness.

### Integration Tests

Test:

- First request misses DB and fetches Moralis.
- Second identical request does not fetch Moralis.
- Two concurrent identical requests result in one Moralis fetch.
- Large missing range queues backfill instead of fetching synchronously.
- Current candle can update.
- Closed historical candle remains stable.
- Circuit breaker disables Moralis calls.

### Load Tests

Simulate:

- 100 users opening the same chart.
- 100 users switching between `1min`, `5min`, and `1h`.
- Malicious user requesting many pairs.
- Cold pair with large range.
- Slightly varied `from`/`to` parameters attempting to bypass cache.

Expected:

- Moralis requests stay bounded.
- Redis/DB cache hit rate increases.
- Rate limits block abuse.
- Queue handles backfills asynchronously.

## Acceptance Criteria

Project is complete when:

- No frontend code calls Moralis.
- Moralis API key is backend-only.
- Chart API uses DB/cache before Moralis.
- Identical chart request does not call Moralis twice.
- Timeframe switching reuses cached/stored data.
- Large `1min` ranges cannot be fetched synchronously by users.
- Backfill worker handles missing historical data.
- Daily jobs refresh hot pairs.
- Daily Moralis CU budget guard exists.
- Metrics show Moralis usage by endpoint, pair, and timeframe.
- Emergency feature flag can disable Moralis provider instantly.

## Key Product Decisions

Before implementation, decide:

1. Which pairs are hot and should be prefilled?
2. What is the default visible range for each timeframe?
3. How much `1min` history do users really need by default?
4. Should cold pairs show Dexscreener until backfill completes?
5. What daily CU budget is acceptable during the migration?
6. Which timeframes must come from Moralis vs internal aggregation?

## Recommended Defaults

```text
Emergency fallback:
  Dexscreener embed

Default DB:
  TimescaleDB/Postgres

Default cache:
  Redis

Default queue:
  BullMQ if Node.js stack

Default visible ranges:
  1min: 24h
  5min: 7d
  1h: 30d
  1d: 1y

Max sync Moralis pages:
  3

Initial hot-pair backfill:
  1min: last 7d
  5min: last 30d
  1h: last 180d
  1d: full supported history if needed

Backfill mode:
  Queue only, not user-blocking

First aggregation target:
  5min, 10min, 30min, 1h from 1min
```
