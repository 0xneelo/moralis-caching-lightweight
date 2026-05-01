# Moralis OHLC Cache - Cache, Gap Detection, and Rate Limits

## Purpose

This document defines the app-level logic that prevents repeated Moralis calls:

- Redis response caching.
- Distributed fetch locks.
- Candle gap detection.
- Request range limits.
- Per-user/IP rate limits.

## Cache Layers

Use multiple layers:

```text
Frontend memory cache:
  Avoid refetching the same range during one chart session.

Redis response cache:
  Avoid recomputing identical backend responses.

TimescaleDB/Postgres:
  Durable candle source of truth.

Moralis:
  Only for missing ranges.
```

## Redis Response Cache

Cache key:

```ts
export function buildChartCacheKey(params: {
  chain: string;
  pairAddress: string;
  timeframe: string;
  currency: string;
  from: Date;
  to: Date;
}) {
  return [
    'chart',
    'ohlcv',
    params.chain,
    params.pairAddress.toLowerCase(),
    params.timeframe,
    params.currency,
    params.from.toISOString(),
    params.to.toISOString(),
  ].join(':');
}
```

TTL:

```ts
export function getChartCacheTtl(timeframe: string): number {
  switch (timeframe) {
    case '1s':
    case '10s':
    case '30s':
      return 5;
    case '1min':
      return 15;
    case '5min':
    case '10min':
      return 30;
    case '30min':
    case '1h':
      return 60;
    default:
      return 300;
  }
}
```

## Distributed Fetch Lock

Multiple users can request the same missing range at the same time. Without a lock, each request may call Moralis.

```ts
export async function withRedisLock<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>
): Promise<T | undefined> {
  const token = crypto.randomUUID();
  const acquired = await redis.set(key, token, 'PX', ttlMs, 'NX');

  if (!acquired) {
    return undefined;
  }

  try {
    return await fn();
  } finally {
    const currentToken = await redis.get(key);
    if (currentToken === token) {
      await redis.del(key);
    }
  }
}
```

Recommended lock key:

```ts
export function buildGapFetchLockKey(params: {
  chain: string;
  pairAddress: string;
  timeframe: string;
  currency: string;
  from: Date;
  to: Date;
}) {
  return [
    'lock',
    'ohlcv',
    params.chain,
    params.pairAddress.toLowerCase(),
    params.timeframe,
    params.currency,
    params.from.toISOString(),
    params.to.toISOString(),
  ].join(':');
}
```

## Candle Alignment

```ts
const TIMEFRAME_SECONDS: Record<string, number> = {
  '1s': 1,
  '10s': 10,
  '30s': 30,
  '1min': 60,
  '5min': 5 * 60,
  '10min': 10 * 60,
  '30min': 30 * 60,
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
  '12h': 12 * 60 * 60,
  '1d': 24 * 60 * 60,
  '1w': 7 * 24 * 60 * 60,
  '1M': 30 * 24 * 60 * 60,
};

export function alignToCandleStart(date: Date, timeframe: string): Date {
  const stepSeconds = TIMEFRAME_SECONDS[timeframe];
  if (!stepSeconds) {
    throw new Error(`Unsupported timeframe: ${timeframe}`);
  }

  const seconds = Math.floor(date.getTime() / 1000);
  const alignedSeconds = Math.floor(seconds / stepSeconds) * stepSeconds;
  return new Date(alignedSeconds * 1000);
}
```

Production note: monthly candles require calendar-aware alignment. Do not use fixed `30 days` for exact `1M` boundaries.

## Gap Detection

```ts
type StoredCandle = {
  timestamp: Date;
};

type TimeRange = {
  from: Date;
  to: Date;
};

export function findMissingRanges(params: {
  candles: StoredCandle[];
  timeframe: string;
  from: Date;
  to: Date;
}): TimeRange[] {
  const stepMs = TIMEFRAME_SECONDS[params.timeframe] * 1000;
  const existing = new Set(
    params.candles.map((c) =>
      alignToCandleStart(c.timestamp, params.timeframe).getTime()
    )
  );

  const gaps: TimeRange[] = [];
  let gapStart: Date | null = null;

  for (
    let ts = alignToCandleStart(params.from, params.timeframe).getTime();
    ts < params.to.getTime();
    ts += stepMs
  ) {
    if (!existing.has(ts)) {
      if (!gapStart) {
        gapStart = new Date(ts);
      }
    } else if (gapStart) {
      gaps.push({ from: gapStart, to: new Date(ts) });
      gapStart = null;
    }
  }

  if (gapStart) {
    gaps.push({ from: gapStart, to: params.to });
  }

  return mergeNearbyRanges(gaps, stepMs);
}

function mergeNearbyRanges(ranges: TimeRange[], stepMs: number): TimeRange[] {
  const merged: TimeRange[] = [];

  for (const range of ranges) {
    const previous = merged[merged.length - 1];

    if (previous && range.from.getTime() - previous.to.getTime() <= stepMs) {
      previous.to = range.to;
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}
```

## Synchronous Gap Policy

Not every missing range should trigger Moralis during a user request.

Recommended policy:

```text
Small gap:
  Fetch synchronously with maxPages <= 3.

Large gap:
  Enqueue backfill job.
  Return existing candles with partial=true.

No stored candles and huge range:
  Return partial=true.
  Queue backfill.
  Consider showing Dexscreener fallback while data is prepared.
```

Example:

```ts
export async function handleGap(params: {
  gap: { from: Date; to: Date };
  chain: string;
  pairAddress: string;
  timeframe: string;
  currency: string;
}) {
  const estimatedCandles = estimateCandleCount(
    params.gap.from,
    params.gap.to,
    params.timeframe
  );

  if (estimatedCandles > 3000) {
    await enqueueBackfillJob(params);
    return { partial: true };
  }

  await fetchAndStoreGap({
    ...params,
    from: params.gap.from,
    to: params.gap.to,
    maxPages: 3,
  });

  return { partial: false };
}
```

## Rate Limits

### Basic Fixed Window

```ts
export async function enforceChartRateLimit(params: {
  userId?: string;
  ip: string;
  pairAddress: string;
}) {
  const actor = params.userId ? `user:${params.userId}` : `ip:${params.ip}`;
  const key = `rate:chart:${actor}`;
  const count = await redis.incr(key);

  if (count === 1) {
    await redis.expire(key, 60);
  }

  if (count > 120) {
    throw new Error('Chart rate limit exceeded');
  }
}
```

### Better Production Limits

Use separate buckets:

```text
Per user:
  120 chart requests/minute

Per IP:
  300 chart requests/minute

Per pair:
  1000 chart requests/minute globally

Per user expensive misses:
  10 cache-miss requests/minute

Per provider:
  Daily CU budget
```

The important distinction is cache hit vs cache miss. Cache hits are cheap. Provider misses can be expensive and should be much more tightly controlled.

## Abuse Patterns to Block

```text
Opening hundreds of charts
Rapid timeframe switching
Requesting full 1min history
Varying from/to slightly to bypass cache keys
Requesting random cold pairs repeatedly
Concurrent requests for same missing range
```

Mitigations:

- Round `from` and `to` to candle boundaries.
- Apply max candle counts.
- Apply max synchronous pages.
- Lock provider fetches.
- Queue large backfills.
- Track top requesting users/IPs.

## Acceptance Criteria

- Identical chart request is cached.
- Concurrent missing range fetches dedupe.
- Large gaps queue backfill instead of synchronously hitting Moralis.
- Cache keys normalize pair address and candle boundaries.
- User/IP rate limits exist.
- Cache miss rate is tracked separately from total chart traffic.
