# Moralis OHLC Cache - Backend API

## Purpose

The backend chart API is the only interface the frontend should use for OHLC candles. It validates requests, enforces limits, checks cache/database, fetches safe missing ranges, and returns normalized chart data.

## Public Chart Endpoint

```http
GET /api/charts/ohlcv
```

Query parameters:

```text
chain=eth
pairAddress=0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640
timeframe=1min
currency=usd
from=2026-04-27T00:00:00.000Z
to=2026-04-28T00:00:00.000Z
```

Response:

```json
{
  "chain": "eth",
  "pairAddress": "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
  "timeframe": "1min",
  "currency": "usd",
  "from": "2026-04-27T00:00:00.000Z",
  "to": "2026-04-28T00:00:00.000Z",
  "source": "cache",
  "partial": false,
  "candles": [
    {
      "time": 1777248000,
      "timestamp": "2026-04-27T00:00:00.000Z",
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

## Admin Backfill Endpoint

This endpoint must be admin-only.

```http
POST /api/admin/charts/backfill
```

Body:

```json
{
  "chain": "eth",
  "pairAddress": "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
  "timeframes": ["1min", "5min", "1h", "1d"],
  "currency": "usd",
  "from": "2025-04-28T00:00:00.000Z",
  "to": "2026-04-28T00:00:00.000Z",
  "priority": "normal"
}
```

Response:

```json
{
  "jobId": "ohlcv_backfill_123",
  "status": "queued"
}
```

## API Types

```ts
export type OhlcvTimeframe =
  | '1s'
  | '10s'
  | '30s'
  | '1min'
  | '5min'
  | '10min'
  | '30min'
  | '1h'
  | '4h'
  | '12h'
  | '1d'
  | '1w'
  | '1M';

export type OhlcvCurrency = 'usd' | 'native';

export type ChartCandle = {
  time: number;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  trades: number | null;
};

export type ChartOhlcvResponse = {
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  from: string;
  to: string;
  source: 'cache' | 'cache+moralis' | 'partial';
  partial: boolean;
  candles: ChartCandle[];
};
```

## Request Validation

### Timeframe Seconds

```ts
export const TIMEFRAME_SECONDS: Record<string, number> = {
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

export function estimateCandleCount(from: Date, to: Date, timeframe: string) {
  const seconds = TIMEFRAME_SECONDS[timeframe];
  if (!seconds) {
    throw new Error(`Unsupported timeframe: ${timeframe}`);
  }

  const rangeSeconds = Math.max(0, (to.getTime() - from.getTime()) / 1000);
  return Math.ceil(rangeSeconds / seconds);
}
```

Production note: `1M` needs calendar-aware alignment. The `30 days` value is acceptable only for rough request sizing.

### Range Guard

```ts
const MAX_SYNC_CANDLES_BY_TIMEFRAME: Record<string, number> = {
  '1s': 300,
  '10s': 600,
  '30s': 1000,
  '1min': 1500,
  '5min': 3000,
  '10min': 3000,
  '30min': 5000,
  '1h': 5000,
  '4h': 5000,
  '12h': 5000,
  '1d': 5000,
  '1w': 2000,
  '1M': 1000,
};

export function assertChartRequestAllowed(params: {
  timeframe: string;
  from: Date;
  to: Date;
}) {
  if (params.to <= params.from) {
    throw new Error('Invalid chart range');
  }

  const estimatedCandles = estimateCandleCount(
    params.from,
    params.to,
    params.timeframe
  );

  const maxCandles = MAX_SYNC_CANDLES_BY_TIMEFRAME[params.timeframe];
  if (!maxCandles) {
    throw new Error(`Unsupported timeframe: ${params.timeframe}`);
  }

  if (estimatedCandles > maxCandles) {
    throw new Error(
      `Requested range is too large for ${params.timeframe}. Estimated candles: ${estimatedCandles}`
    );
  }
}
```

## Chart Service Algorithm

```text
1. Parse query parameters.
2. Normalize pair address to lowercase.
3. Validate timeframe, currency, chain, from, and to.
4. Enforce per-user/IP rate limit.
5. Build exact Redis response cache key.
6. Return Redis response if present.
7. Query stored candles from database.
8. Detect missing candle ranges.
9. For small gaps, fetch from Moralis with maxPages.
10. For large gaps, enqueue backfill and return partial data.
11. Re-query database.
12. Return normalized sorted candles.
13. Cache response in Redis.
```

## Example Route Handler

```ts
export async function getOhlcvRoute(req: Request) {
  const url = new URL(req.url);

  const chain = requiredString(url.searchParams.get('chain'));
  const pairAddress = requiredString(url.searchParams.get('pairAddress')).toLowerCase();
  const timeframe = requiredTimeframe(url.searchParams.get('timeframe'));
  const currency = requiredCurrency(url.searchParams.get('currency') ?? 'usd');
  const from = requiredDate(url.searchParams.get('from'));
  const to = requiredDate(url.searchParams.get('to'));

  const response = await getOhlcvForChart({
    chain,
    pairAddress,
    timeframe,
    currency,
    from,
    to,
    userId: req.user?.id,
    ip: getClientIp(req),
  });

  return Response.json(response, {
    headers: {
      'Cache-Control': 'private, max-age=5',
    },
  });
}
```

## Example Chart Service

```ts
export async function getOhlcvForChart(params: {
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  from: Date;
  to: Date;
  userId?: string;
  ip: string;
}): Promise<ChartOhlcvResponse> {
  const pairAddress = params.pairAddress.toLowerCase();

  assertChartRequestAllowed({
    timeframe: params.timeframe,
    from: params.from,
    to: params.to,
  });

  await enforceChartRateLimit({
    userId: params.userId,
    ip: params.ip,
    pairAddress,
  });

  const cacheKey = buildChartCacheKey({ ...params, pairAddress });
  const cached = await redis.get(cacheKey);

  if (cached) {
    return JSON.parse(cached) as ChartOhlcvResponse;
  }

  const storedCandles = await candleRepository.findCandles({
    chain: params.chain,
    pairAddress,
    timeframe: params.timeframe,
    currency: params.currency,
    from: params.from,
    to: params.to,
  });

  const gaps = findMissingRanges({
    candles: storedCandles,
    timeframe: params.timeframe,
    from: params.from,
    to: params.to,
  });

  let partial = false;

  for (const gap of gaps) {
    const estimatedGapCandles = estimateCandleCount(
      gap.from,
      gap.to,
      params.timeframe
    );

    if (estimatedGapCandles > 3000) {
      await enqueueBackfillJob({
        chain: params.chain,
        pairAddress,
        timeframe: params.timeframe,
        currency: params.currency,
        from: gap.from,
        to: gap.to,
      });

      partial = true;
      continue;
    }

    await fetchAndStoreGap({
      chain: params.chain,
      pairAddress,
      timeframe: params.timeframe,
      currency: params.currency,
      from: gap.from,
      to: gap.to,
      maxPages: 3,
    });
  }

  const finalCandles = await candleRepository.findCandles({
    chain: params.chain,
    pairAddress,
    timeframe: params.timeframe,
    currency: params.currency,
    from: params.from,
    to: params.to,
  });

  const response: ChartOhlcvResponse = {
    chain: params.chain,
    pairAddress,
    timeframe: params.timeframe,
    currency: params.currency,
    from: params.from.toISOString(),
    to: params.to.toISOString(),
    source: partial ? 'partial' : gaps.length > 0 ? 'cache+moralis' : 'cache',
    partial,
    candles: finalCandles.map(toChartCandle),
  };

  await redis.set(
    cacheKey,
    JSON.stringify(response),
    'EX',
    getChartCacheTtl(params.timeframe)
  );

  return response;
}
```

## API Acceptance Criteria

- Browser calls only `/api/charts/ohlcv`.
- Route rejects unsupported timeframes.
- Route rejects oversized ranges.
- Route rate-limits abusive users/IPs.
- Route never performs unbounded Moralis pagination.
- Repeated identical request returns from Redis or database.
- Large missing ranges enqueue backfill.
- Response shape stays stable for frontend chart code.
