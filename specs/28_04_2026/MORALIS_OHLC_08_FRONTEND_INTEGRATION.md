# Moralis OHLC Cache - Frontend Integration

## Purpose

The frontend must stop acting as a Moralis client. It should request chart data only from our backend, cache recent chart responses in memory, and request only the visible range needed for the chart.

## Hard Rules

- No frontend Moralis calls.
- No `MORALIS_API_KEY` in frontend env.
- No `NEXT_PUBLIC_MORALIS_*`.
- No `VITE_MORALIS_*`.
- No direct calls to `deep-index.moralis.io`.
- No full-history request on chart open.
- No full-history request on every timeframe switch.

## Search Checklist

Remove frontend references to:

```text
deep-index.moralis.io
solana-gateway.moralis.io
pairs/{address}/ohlcv
X-API-Key
MORALIS_API_KEY
NEXT_PUBLIC_MORALIS
VITE_MORALIS
```

## Chart Provider Switch

Use a feature flag so the team can switch between Dexscreener and internal charts.

```ts
export type ChartProvider = 'dexscreener' | 'internal';

export function getChartProvider(): ChartProvider {
  return (process.env.NEXT_PUBLIC_CHART_PROVIDER as ChartProvider) ?? 'dexscreener';
}
```

Example component:

```tsx
export function TokenChart(props: {
  chainId: string;
  chain: string;
  pairAddress: string;
}) {
  const provider = getChartProvider();

  if (provider === 'dexscreener') {
    return (
      <iframe
        title="Dexscreener chart"
        src={`https://dexscreener.com/${props.chainId}/${props.pairAddress}?embed=1`}
        style={{ width: '100%', height: 520, border: 0 }}
      />
    );
  }

  return (
    <InternalTradingChart
      chain={props.chain}
      pairAddress={props.pairAddress}
    />
  );
}
```

## Backend Chart Loader

```ts
export async function loadChartData(params: {
  chain: string;
  pairAddress: string;
  timeframe: string;
  from: Date;
  to: Date;
}) {
  const url = new URL('/api/charts/ohlcv', window.location.origin);
  url.searchParams.set('chain', params.chain);
  url.searchParams.set('pairAddress', params.pairAddress);
  url.searchParams.set('timeframe', params.timeframe);
  url.searchParams.set('currency', 'usd');
  url.searchParams.set('from', params.from.toISOString());
  url.searchParams.set('to', params.to.toISOString());

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Chart data failed: ${response.status}`);
  }

  return response.json();
}
```

## Default Visible Ranges

Do not load full history by default.

```ts
export function getDefaultChartRange(timeframe: string) {
  const now = new Date();
  const day = 24 * 60 * 60 * 1000;

  switch (timeframe) {
    case '1min':
      return { from: new Date(now.getTime() - day), to: now };
    case '5min':
      return { from: new Date(now.getTime() - 7 * day), to: now };
    case '1h':
      return { from: new Date(now.getTime() - 30 * day), to: now };
    case '1d':
      return { from: new Date(now.getTime() - 365 * day), to: now };
    default:
      return { from: new Date(now.getTime() - 30 * day), to: now };
  }
}
```

## Timeframe Switching

When user switches timeframe:

1. Compute default visible range for that timeframe.
2. Check frontend memory cache.
3. Render cached data immediately if present.
4. Request backend for fresh data.
5. Do not request all historical data.

```ts
const chartMemoryCache = new Map<string, unknown>();

function getMemoryCacheKey(params: {
  chain: string;
  pairAddress: string;
  timeframe: string;
  from: Date;
  to: Date;
}) {
  return [
    params.chain,
    params.pairAddress.toLowerCase(),
    params.timeframe,
    params.from.toISOString(),
    params.to.toISOString(),
  ].join(':');
}

export async function loadChartDataWithMemoryCache(params: {
  chain: string;
  pairAddress: string;
  timeframe: string;
  from: Date;
  to: Date;
}) {
  const key = getMemoryCacheKey(params);
  const cached = chartMemoryCache.get(key);

  if (cached) {
    return cached;
  }

  const data = await loadChartData(params);
  chartMemoryCache.set(key, data);
  return data;
}
```

## Handling Partial Data

Backend may return `partial=true` when a large missing range has been queued.

```tsx
export function ChartStatus(props: {
  partial: boolean;
}) {
  if (!props.partial) {
    return null;
  }

  return (
    <div className="chart-status">
      Historical data is still loading. Recent candles are shown first.
    </div>
  );
}
```

## Lazy Loading Older History

When the user pans left:

- Request only the newly visible older range.
- Do not request from token launch to now.
- Debounce pan requests.
- Abort stale requests.

Example:

```ts
let currentAbortController: AbortController | null = null;

export async function loadOlderCandles(params: {
  chain: string;
  pairAddress: string;
  timeframe: string;
  from: Date;
  to: Date;
}) {
  currentAbortController?.abort();
  currentAbortController = new AbortController();

  const url = new URL('/api/charts/ohlcv', window.location.origin);
  url.searchParams.set('chain', params.chain);
  url.searchParams.set('pairAddress', params.pairAddress);
  url.searchParams.set('timeframe', params.timeframe);
  url.searchParams.set('currency', 'usd');
  url.searchParams.set('from', params.from.toISOString());
  url.searchParams.set('to', params.to.toISOString());

  const response = await fetch(url, {
    signal: currentAbortController.signal,
  });

  return response.json();
}
```

## Chart Data Conversion

For TradingView Lightweight Charts:

```ts
export function toLightweightCandles(candles: Array<{
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}>) {
  return candles
    .map((candle) => ({
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    }))
    .sort((a, b) => a.time - b.time);
}
```

## Frontend Acceptance Criteria

- Browser network tab shows only our backend chart endpoint.
- No Moralis key in frontend bundle.
- Chart open requests only visible range.
- Timeframe switching reuses frontend memory cache where possible.
- Older history loads incrementally.
- Partial backfill state is handled gracefully.
- Dexscreener fallback can be enabled instantly.
