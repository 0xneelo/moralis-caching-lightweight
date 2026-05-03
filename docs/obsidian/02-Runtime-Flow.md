---
tags: [repo-map, runtime, flow]
---

# Runtime Flow

Related: [[01-Architecture]], [[03-API-Surface]], [[05-Backend-Map]], [[06-Frontend-Map]]

## Startup flows

### Docker-backed development

```text
start.* -> npm --prefix moralisCacheSystem run dev:docker
  -> scripts/start-infra.ps1
  -> docker compose up postgres redis
  -> npm run migrate
  -> concurrently API + worker + frontend
```

### Local memory mode

```text
npm run dev or npm run dev:local
  -> src/localIndex.ts API on :3001
  -> Vite frontend on :5173
```

Local mode does not require Redis/Postgres. It is for UI/testing, not production.

## Main chart request flow

```mermaid
sequenceDiagram
  participant Browser
  participant Route as chartRoutes.ts
  participant Service as chartService.ts
  participant Redis
  participant DB as Postgres
  participant Moralis
  participant Queue as BullMQ

  Browser->>Route: GET /api/charts/ohlcv
  Route->>Route: validate query + adaptive timeframe
  Route->>Service: getOhlcvForChart(...)
  Service->>Service: normalize pair + range guard + rate limit
  Service->>DB: touch pair + read market history state
  Service->>Queue: enqueue full-history/daily bootstrap if needed
  Service->>Redis: read response cache
  alt full cache hit and valid
    Service-->>Route: cached response
  else cache miss/partial/history incomplete
    Service->>DB: find candles in range
    Service->>Service: find missing/suspicious ranges
    alt daily bootstrap required
      Service-->>Route: partial/warming response
    else small gap and budget available
      Service->>Redis: acquire gap lock
      Service->>Moralis: fetch OHLCV pages
      Moralis-->>Service: candles
      Service->>DB: upsert candles + history bounds + usage
    else large gap
      Service->>Queue: enqueue backfill
    end
    Service->>DB: reload candles
    Service->>Redis: set response cache if complete
    Service-->>Route: chart response
  end
  Route-->>Browser: JSON + cache/history headers
```

## Full-history warmup behavior

- History floor is hardcoded to `2024-01-01T00:00:00.000Z` in `chartService.ts`.
- A non-daily request requires daily (`1d`) bootstrap first.
- Full-history requests enqueue high-priority `initial_history_load` jobs.
- While history is queued/running, responses can indicate:
  - `historyWarming: true`
  - `historyProgressPct`
  - `partial: true`
  - `source: partial`

## Worker flow

```mermaid
flowchart TD
  WorkerStart[src/worker.ts] --> AssertRedis[assertRedisAvailable]
  AssertRedis --> CreateWorker[createBackfillWorker]
  CreateWorker --> Job[Backfill job]
  Job --> MarkRunning[backfillJobRepository.markRunning]
  MarkRunning --> Fetch[fetchMoralisOhlcv]
  Fetch --> Upsert[candleRepository.upsertCandles]
  Upsert --> Bounds[marketHistoryStateRepository.upsertBoundsFromCandles]
  Bounds --> Usage[providerUsageRepository.log]
  Usage --> Complete[mark completed/failed]
```

## Frontend runtime behavior

- `App.tsx` tracks chain, pair, timeframe, chart range, visible range, response, usage, and int
