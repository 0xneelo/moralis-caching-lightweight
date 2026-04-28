# Moralis OHLC Cache - Database and Storage

## Purpose

The database stores fetched OHLC candles so historical data is paid for once and reused across users, sessions, page loads, and timeframe switches.

Recommended database:

```text
TimescaleDB/Postgres
```

Why:

- OHLC data is time-series data.
- We need normal relational keys by chain, pair, timeframe, currency, and timestamp.
- We need safe upserts.
- We need fast range queries.
- We may want Timescale continuous aggregates later.

Redis should not be the source of truth. Redis is for response cache, locks, rate limits, and feature flags.

## Candle Table

```sql
CREATE TABLE ohlcv_candles (
  chain TEXT NOT NULL,
  pair_address TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  timestamp TIMESTAMPTZ NOT NULL,
  open NUMERIC NOT NULL,
  high NUMERIC NOT NULL,
  low NUMERIC NOT NULL,
  close NUMERIC NOT NULL,
  volume NUMERIC,
  trades INTEGER,
  source TEXT NOT NULL DEFAULT 'moralis',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, pair_address, timeframe, currency, timestamp)
);

SELECT create_hypertable('ohlcv_candles', 'timestamp', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS ohlcv_candles_lookup_idx
ON ohlcv_candles (chain, pair_address, timeframe, currency, timestamp DESC);
```

## Pair Metadata Table

```sql
CREATE TABLE chart_pairs (
  chain TEXT NOT NULL,
  pair_address TEXT NOT NULL,
  base_token_address TEXT,
  quote_token_address TEXT,
  symbol TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_hot BOOLEAN NOT NULL DEFAULT FALSE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_requested_at TIMESTAMPTZ,
  last_refreshed_at TIMESTAMPTZ,
  request_count_24h INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chain, pair_address)
);

CREATE INDEX IF NOT EXISTS chart_pairs_hot_idx
ON chart_pairs (is_hot, is_active, last_requested_at DESC);
```

## Backfill Job Table

If the queue already persists jobs, this table is optional. It is still useful for debugging and admin dashboards.

```sql
CREATE TABLE ohlcv_backfill_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain TEXT NOT NULL,
  pair_address TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  from_ts TIMESTAMPTZ NOT NULL,
  to_ts TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  priority TEXT NOT NULL DEFAULT 'normal',
  error_message TEXT,
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  candles_inserted INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ohlcv_backfill_jobs_status_idx
ON ohlcv_backfill_jobs (status, priority, created_at);
```

## Provider Usage Table

Track Moralis usage internally so the team can see costs before the invoice arrives.

```sql
CREATE TABLE provider_api_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  chain TEXT,
  pair_address TEXT,
  timeframe TEXT,
  request_from TIMESTAMPTZ,
  request_to TIMESTAMPTZ,
  http_status INTEGER,
  estimated_cu INTEGER NOT NULL DEFAULT 0,
  pages INTEGER NOT NULL DEFAULT 1,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS provider_api_usage_created_idx
ON provider_api_usage (created_at DESC, provider, endpoint);

CREATE INDEX IF NOT EXISTS provider_api_usage_pair_idx
ON provider_api_usage (provider, chain, pair_address, timeframe, created_at DESC);
```

## Optional Coverage Table

This table tracks which ranges are known complete. It is useful later, but phase 1 can compute gaps by reading candle timestamps.

```sql
CREATE TABLE ohlcv_coverage (
  chain TEXT NOT NULL,
  pair_address TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  covered_from TIMESTAMPTZ NOT NULL,
  covered_to TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, pair_address, timeframe, currency, covered_from, covered_to)
);
```

Coverage ranges are easy to get wrong because overlapping ranges must be merged. Do not add this until the basic cache-first path is stable.

## Upsert Candle SQL

```sql
INSERT INTO ohlcv_candles (
  chain,
  pair_address,
  timeframe,
  currency,
  timestamp,
  open,
  high,
  low,
  close,
  volume,
  trades,
  source,
  updated_at
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'moralis', now()
)
ON CONFLICT (chain, pair_address, timeframe, currency, timestamp)
DO UPDATE SET
  open = EXCLUDED.open,
  high = EXCLUDED.high,
  low = EXCLUDED.low,
  close = EXCLUDED.close,
  volume = EXCLUDED.volume,
  trades = EXCLUDED.trades,
  source = EXCLUDED.source,
  updated_at = now();
```

Current/open candles can change, so updates are correct. Historical closed candles should rarely change, but allowing idempotent updates keeps ingestion simple.

## Repository Example

```ts
export const candleRepository = {
  async findCandles(params: {
    chain: string;
    pairAddress: string;
    timeframe: string;
    currency: string;
    from: Date;
    to: Date;
  }) {
    return db.query(
      `
      SELECT timestamp, open, high, low, close, volume, trades
      FROM ohlcv_candles
      WHERE chain = $1
        AND pair_address = $2
        AND timeframe = $3
        AND currency = $4
        AND timestamp >= $5
        AND timestamp <= $6
      ORDER BY timestamp ASC
      `,
      [
        params.chain,
        params.pairAddress,
        params.timeframe,
        params.currency,
        params.from,
        params.to,
      ]
    );
  },

  async upsertCandles(params: {
    chain: string;
    pairAddress: string;
    timeframe: string;
    currency: string;
    candles: Array<{
      timestamp: string;
      open: number;
      high: number;
      low: number;
      close: number;
      volume?: number;
      trades?: number;
    }>;
  }) {
    await db.transaction(async (tx) => {
      for (const candle of params.candles) {
        await tx.query(UPSERT_CANDLE_SQL, [
          params.chain,
          params.pairAddress,
          params.timeframe,
          params.currency,
          new Date(candle.timestamp),
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.volume ?? null,
          candle.trades ?? null,
        ]);
      }
    });
  },
};
```

For higher volume ingestion, replace row-by-row inserts with batched inserts or `COPY`.

## Usage Logging Example

```ts
export const providerUsageRepository = {
  async log(params: {
    provider: string;
    endpoint: string;
    chain?: string;
    pairAddress?: string;
    timeframe?: string;
    requestFrom?: Date;
    requestTo?: Date;
    httpStatus?: number;
    estimatedCu: number;
    pages: number;
    durationMs?: number;
  }) {
    await db.query(
      `
      INSERT INTO provider_api_usage (
        provider,
        endpoint,
        chain,
        pair_address,
        timeframe,
        request_from,
        request_to,
        http_status,
        estimated_cu,
        pages,
        duration_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `,
      [
        params.provider,
        params.endpoint,
        params.chain ?? null,
        params.pairAddress ?? null,
        params.timeframe ?? null,
        params.requestFrom ?? null,
        params.requestTo ?? null,
        params.httpStatus ?? null,
        params.estimatedCu,
        params.pages,
        params.durationMs ?? null,
      ]
    );
  },

  async sumEstimatedCu(params: {
    provider: string;
    from: Date;
    to: Date;
  }) {
    const result = await db.query(
      `
      SELECT COALESCE(sum(estimated_cu), 0)::bigint AS total
      FROM provider_api_usage
      WHERE provider = $1
        AND created_at >= $2
        AND created_at < $3
      `,
      [params.provider, params.from, params.to]
    );

    return Number(result.rows[0].total);
  },
};
```

## Retention and Compression

Initial recommendation:

- Keep `1min` candles for hot pairs for at least 6-12 months if storage is affordable.
- Keep higher timeframes indefinitely.
- Compress older chunks with TimescaleDB compression after they are no longer frequently updated.

Example Timescale compression:

```sql
ALTER TABLE ohlcv_candles SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'chain,pair_address,timeframe,currency'
);

SELECT add_compression_policy('ohlcv_candles', INTERVAL '30 days');
```

## Storage Acceptance Criteria

- Candle uniqueness is enforced in the database.
- Range query by pair/timeframe is indexed.
- Re-inserting the same candle is idempotent.
- Provider usage is logged for cost analysis.
- Database supports future aggregation from lower timeframes.
- Redis is not required to recover historical candle data.
