# Moralis OHLC Cache Project Spec

This is the index for the Moralis OHLC cost-reduction project. The original monolithic spec has been split into app-level documents so each team member can focus on the part they own.

## Reading Order

1. [`MORALIS_OHLC_01_OVERVIEW_ARCHITECTURE.md`](MORALIS_OHLC_01_OVERVIEW_ARCHITECTURE.md)
2. [`MORALIS_OHLC_02_EMERGENCY_CUTOFF.md`](MORALIS_OHLC_02_EMERGENCY_CUTOFF.md)
3. [`MORALIS_OHLC_03_BACKEND_API.md`](MORALIS_OHLC_03_BACKEND_API.md)
4. [`MORALIS_OHLC_04_DATABASE_STORAGE.md`](MORALIS_OHLC_04_DATABASE_STORAGE.md)
5. [`MORALIS_OHLC_05_MORALIS_PROVIDER.md`](MORALIS_OHLC_05_MORALIS_PROVIDER.md)
6. [`MORALIS_OHLC_06_CACHE_GAPS_RATE_LIMITS.md`](MORALIS_OHLC_06_CACHE_GAPS_RATE_LIMITS.md)
7. [`MORALIS_OHLC_07_WORKERS_AGGREGATION.md`](MORALIS_OHLC_07_WORKERS_AGGREGATION.md)
8. [`MORALIS_OHLC_08_FRONTEND_INTEGRATION.md`](MORALIS_OHLC_08_FRONTEND_INTEGRATION.md)
9. [`MORALIS_OHLC_09_SECURITY_OBSERVABILITY_TESTING.md`](MORALIS_OHLC_09_SECURITY_OBSERVABILITY_TESTING.md)

## Document Map

### 1. Overview and Architecture

File: [`MORALIS_OHLC_01_OVERVIEW_ARCHITECTURE.md`](MORALIS_OHLC_01_OVERVIEW_ARCHITECTURE.md)

Covers:

- Current problem.
- Moralis billing interpretation.
- Target architecture.
- Component responsibilities.
- Data ownership rules.
- Recommended stack.
- Project goals and success criteria.

Start here if you need the full mental model.

### 2. Emergency Cutoff

File: [`MORALIS_OHLC_02_EMERGENCY_CUTOFF.md`](MORALIS_OHLC_02_EMERGENCY_CUTOFF.md)

Covers:

- Disabling Moralis-backed charts immediately.
- Dexscreener temporary fallback.
- API key rotation.
- Provider circuit breaker.
- Temporary range limits.
- Temporary rate limits.
- Verification checklist.

Use this for the same-day cost containment work.

### 3. Backend API

File: [`MORALIS_OHLC_03_BACKEND_API.md`](MORALIS_OHLC_03_BACKEND_API.md)

Covers:

- Public chart endpoint.
- Admin backfill endpoint.
- API request/response types.
- Request validation.
- Backend chart service algorithm.
- Example route handler.
- Example cache-first service.

Use this for the app API implementation.

### 4. Database and Storage

File: [`MORALIS_OHLC_04_DATABASE_STORAGE.md`](MORALIS_OHLC_04_DATABASE_STORAGE.md)

Covers:

- TimescaleDB/Postgres recommendation.
- Candle schema.
- Pair metadata schema.
- Backfill job schema.
- Provider usage schema.
- Optional coverage schema.
- Upsert logic.
- Repository examples.
- Retention and compression.

Use this for migrations and persistence.

### 5. Moralis Provider

File: [`MORALIS_OHLC_05_MORALIS_PROVIDER.md`](MORALIS_OHLC_05_MORALIS_PROVIDER.md)

Covers:

- Backend-only Moralis adapter.
- Endpoint details.
- Moralis response types.
- Pagination-safe fetcher.
- Error handling.
- Fetch-and-store gap logic.
- CU budget guard.
- Circuit breaker.
- Retry policy.
- Endpoint weights verification.

Use this for the provider integration.

### 6. Cache, Gaps, and Rate Limits

File: [`MORALIS_OHLC_06_CACHE_GAPS_RATE_LIMITS.md`](MORALIS_OHLC_06_CACHE_GAPS_RATE_LIMITS.md)

Covers:

- Cache layers.
- Redis response keys.
- Cache TTLs.
- Distributed fetch locks.
- Candle alignment.
- Gap detection.
- Synchronous vs queued gap policy.
- Rate limits.
- Abuse patterns.

Use this for the core cost-control logic.

### 7. Workers and Aggregation

File: [`MORALIS_OHLC_07_WORKERS_AGGREGATION.md`](MORALIS_OHLC_07_WORKERS_AGGREGATION.md)

Covers:

- Worker job types.
- Queue payloads.
- Active pair refresh.
- Initial backfill policy.
- Backfill worker.
- Chunking large jobs.
- Daily gap fill.
- Aggregation strategy.
- Timescale continuous aggregate examples.

Use this for background jobs and reducing future provider calls.

### 8. Frontend Integration

File: [`MORALIS_OHLC_08_FRONTEND_INTEGRATION.md`](MORALIS_OHLC_08_FRONTEND_INTEGRATION.md)

Covers:

- Frontend hard rules.
- Search checklist for removing Moralis calls.
- Dexscreener/internal chart switch.
- Backend chart loader.
- Default visible ranges.
- Timeframe switching behavior.
- Partial data handling.
- Lazy loading older history.
- TradingView data conversion.

Use this for chart UI changes.

### 9. Security, Observability, Rollout, and Testing

File: [`MORALIS_OHLC_09_SECURITY_OBSERVABILITY_TESTING.md`](MORALIS_OHLC_09_SECURITY_OBSERVABILITY_TESTING.md)

Covers:

- Secret handling.
- Key rotation.
- Abuse prevention.
- Circuit breaker.
- Metrics.
- SQL usage queries.
- Alerts.
- Rollout phases.
- Unit, integration, and load testing.
- Final acceptance criteria.

Use this for production readiness.

## Recommended Build Sequence

```text
Phase 0:
  Emergency cutoff + Dexscreener fallback

Phase 1:
  Backend chart API with validation and rate limits

Phase 2:
  TimescaleDB candle storage + Redis response cache + fetch locks

Phase 3:
  Backfill workers + daily refresh + CU budget guard

Phase 4:
  Internal aggregation for higher timeframes

Phase 5:
  Observability dashboards, alerts, and load testing
```

## Core Rule

The frontend must never call Moralis. Moralis should be treated as a backend data provider for missing candles only, not as the runtime chart API.
