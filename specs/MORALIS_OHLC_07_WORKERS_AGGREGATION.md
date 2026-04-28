# Moralis OHLC Cache - Workers and Aggregation

## Purpose

Background workers keep expensive historical fetching away from user requests. They refresh active pairs, backfill missing ranges, repair gaps, and eventually aggregate higher timeframes internally.

## Job Types

```text
refresh-active-pairs:
  Runs every 1-5 minutes.
  Updates recent candles for hot pairs.

daily-gap-fill:
  Runs once per day.
  Repairs missing historical ranges.

initial-backfill:
  Runs when a pair becomes hot/listed.
  Downloads bounded historical data.

cold-pair-on-demand:
  Runs after first request for a new pair.
  Fetches recent chart data first, then deeper history.

aggregate-timeframes:
  Builds 5m/10m/30m/1h/etc from lower timeframe candles.
```

## Queue Payloads

```ts
export type OhlcvBackfillJob = {
  chain: string;
  pairAddress: string;
  timeframe: string;
  currency: 'usd' | 'native';
  from: string;
  to: string;
  priority: 'low' | 'normal' | 'high';
  reason: 'admin' | 'user_gap' | 'active_refresh' | 'daily_gap_fill';
};
```

## Active Pair Refresh

```ts
export async function refreshActivePairs() {
  const pairs = await pairRepository.findHotPairs({ limit: 500 });

  for (const pair of pairs) {
    await backfillQueue.add('refreshPair', {
      chain: pair.chain,
      pairAddress: pair.pairAddress,
      timeframe: '1min',
      currency: 'usd',
      from: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      priority: 'high',
      reason: 'active_refresh',
    });
  }
}
```

Schedule:

```text
Hot pairs:
  Every 1-5 minutes

Warm pairs:
  Every 15-60 minutes

Cold pairs:
  On demand only
```

## Initial Backfill Policy

Recommended defaults:

```text
Hot pair initial backfill:
  1min: last 7 days
  5min: last 30 days
  1h: last 180 days
  1d: full needed history

Cold pair first request:
  Fetch visible range only
  Queue deeper history

Admin-triggered backfill:
  Allowed but budget guarded
```

Do not blindly download all known charts unless the token universe is small and bounded.

## Backfill Worker

```ts
export async function processBackfillJob(job: OhlcvBackfillJob) {
  const estimatedMaxCu = 100 * 150;
  await assertDailyMoralisBudgetAvailable(estimatedMaxCu);

  const result = await fetchMoralisOhlcv({
    apiKey: process.env.MORALIS_API_KEY!,
    chain: job.chain,
    pairAddress: job.pairAddress,
    timeframe: job.timeframe as OhlcvTimeframe,
    currency: job.currency,
    fromDate: new Date(job.from),
    toDate: new Date(job.to),
    maxPages: 100,
  });

  await candleRepository.upsertCandles({
    chain: job.chain,
    pairAddress: job.pairAddress.toLowerCase(),
    timeframe: job.timeframe,
    currency: job.currency,
    candles: result.candles,
  });

  await providerUsageRepository.log({
    provider: 'moralis',
    endpoint: 'getPairCandlesticks',
    chain: job.chain,
    pairAddress: job.pairAddress.toLowerCase(),
    timeframe: job.timeframe,
    requestFrom: new Date(job.from),
    requestTo: new Date(job.to),
    httpStatus: 200,
    estimatedCu: result.estimatedCu,
    pages: result.pages,
  });
}
```

## Chunking Large Backfills

Large jobs should be split into smaller chunks. This makes progress observable and prevents one huge job from monopolizing the worker.

```ts
export function splitBackfillRange(params: {
  from: Date;
  to: Date;
  chunkMs: number;
}) {
  const chunks: Array<{ from: Date; to: Date }> = [];

  for (
    let cursor = params.from.getTime();
    cursor < params.to.getTime();
    cursor += params.chunkMs
  ) {
    chunks.push({
      from: new Date(cursor),
      to: new Date(Math.min(cursor + params.chunkMs, params.to.getTime())),
    });
  }

  return chunks;
}
```

Recommended chunks:

```text
1min:
  1-7 days per job

5min:
  7-30 days per job

1h:
  30-180 days per job

1d:
  1-5 years per job
```

## Daily Gap Fill

```ts
export async function enqueueDailyGapFill() {
  const pairs = await pairRepository.findActivePairs({ limit: 1000 });

  for (const pair of pairs) {
    await backfillQueue.add('dailyGapFill', {
      chain: pair.chain,
      pairAddress: pair.pairAddress,
      timeframe: '1min',
      currency: 'usd',
      from: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
      priority: pair.isHot ? 'high' : 'normal',
      reason: 'daily_gap_fill',
    });
  }
}
```

Daily gap fill should prioritize:

1. Pairs viewed in the last 24h.
2. Hot/listed pairs.
3. Pairs with known missing coverage.
4. Everything else only if CU budget remains.

## Aggregation Strategy

### Phase 1: Store Moralis Timeframes Separately

```text
1min stored from Moralis
5min stored from Moralis
1h stored from Moralis
1d stored from Moralis
```

This is simplest and lowest risk.

### Phase 2: Aggregate Higher Timeframes Internally

```text
1min -> 5min
1min -> 10min
1min -> 30min
1min -> 1h
1h -> 4h
1h -> 12h
1h -> 1d
1d -> 1w
```

Aggregation rules:

```text
open = first open in bucket
high = max high in bucket
low = min low in bucket
close = last close in bucket
volume = sum volume
trades = sum trades
timestamp = bucket start
```

## SQL Aggregation Example

```sql
SELECT
  time_bucket('5 minutes', timestamp) AS bucket,
  first(open, timestamp) AS open,
  max(high) AS high,
  min(low) AS low,
  last(close, timestamp) AS close,
  sum(volume) AS volume,
  sum(trades) AS trades
FROM ohlcv_candles
WHERE chain = $1
  AND pair_address = $2
  AND timeframe = '1min'
  AND currency = $3
  AND timestamp >= $4
  AND timestamp < $5
GROUP BY bucket
ORDER BY bucket ASC;
```

## Timescale Continuous Aggregate

```sql
CREATE MATERIALIZED VIEW ohlcv_5min
WITH (timescaledb.continuous) AS
SELECT
  chain,
  pair_address,
  currency,
  time_bucket('5 minutes', timestamp) AS timestamp,
  first(open, timestamp) AS open,
  max(high) AS high,
  min(low) AS low,
  last(close, timestamp) AS close,
  sum(volume) AS volume,
  sum(trades) AS trades
FROM ohlcv_candles
WHERE timeframe = '1min'
GROUP BY chain, pair_address, currency, time_bucket('5 minutes', timestamp);
```

Add refresh policy:

```sql
SELECT add_continuous_aggregate_policy(
  'ohlcv_5min',
  start_offset => INTERVAL '7 days',
  end_offset => INTERVAL '5 minutes',
  schedule_interval => INTERVAL '5 minutes'
);
```

## Worker Safety Rules

- Workers must respect daily CU budget.
- Workers must stop when Moralis circuit breaker is off.
- Workers must retry with backoff.
- Workers must not run unlimited historical backfills.
- Workers must record pages fetched and estimated CUs.
- Workers must chunk large date ranges.

## Acceptance Criteria

- Hot pairs refresh without user requests.
- Large missing ranges are queued.
- Daily jobs repair recent gaps.
- Backfill jobs are chunked.
- Workers pause when CU budget is reached.
- Aggregated higher timeframes can be served without Moralis once base data exists.
