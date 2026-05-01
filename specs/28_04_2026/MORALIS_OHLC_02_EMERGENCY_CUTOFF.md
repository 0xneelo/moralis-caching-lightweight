# Moralis OHLC Cache - Emergency Cutoff

## Purpose

This document covers the immediate production response before the permanent caching backend is ready.

The goal is to stop uncontrolled Moralis spend today. If users can trigger Moralis OHLC calls by opening charts or switching timeframes, the safest short-term move is to disable Moralis-backed chart loading and use Dexscreener or a bounded fallback.

## Emergency Decision

Disable Moralis-backed charts in beta until:

- Browser code no longer calls Moralis.
- The Moralis key is backend-only.
- Backend chart requests are range-limited.
- Backend stores and reuses candles.
- Heavy backfills run through a queue.

## Immediate Actions

### 1. Disable Direct Moralis Chart Loading

Search for and remove browser usage of:

```text
deep-index.moralis.io
solana-gateway.moralis.io
pairs/{address}/ohlcv
X-API-Key
MORALIS_API_KEY
NEXT_PUBLIC_MORALIS
VITE_MORALIS
```

If any of these are visible in frontend code, remove them before re-enabling Moralis.

### 2. Switch to Dexscreener Temporarily

Use Dexscreener as a temporary fallback for beta charts.

Example feature flag:

```ts
export const chartProvider = process.env.CHART_PROVIDER ?? 'dexscreener';

export function shouldUseDexscreenerChart() {
  return chartProvider === 'dexscreener';
}

export function shouldUseInternalChartApi() {
  return chartProvider === 'internal';
}
```

Example frontend branch:

```tsx
export function TokenChart(props: {
  chainId: string;
  pairAddress: string;
}) {
  if (shouldUseDexscreenerChart()) {
    return (
      <iframe
        title="Dexscreener chart"
        src={`https://dexscreener.com/${props.chainId}/${props.pairAddress}?embed=1`}
        style={{ width: '100%', height: 520, border: 0 }}
      />
    );
  }

  return <InternalTradingChart {...props} />;
}
```

Adjust Dexscreener URL format to match the chains actually used by the app.

### 3. Rotate Moralis API Key

If the key was ever exposed client-side, treat it as compromised.

Steps:

1. Create a new Moralis API key.
2. Store it in backend secret manager only.
3. Deploy backend with the new key.
4. Revoke the old key.
5. Confirm browser network tab shows no Moralis requests.
6. Confirm source maps and frontend bundles do not contain the key.

### 4. Add a Provider Circuit Breaker

Backend should have a kill switch that disables Moralis without code changes.

```ts
export async function isMoralisOhlcvEnabled() {
  const value = await redis.get('feature:moralis_ohlcv_enabled');
  return value !== 'false';
}

export async function assertMoralisOhlcvEnabled() {
  if (!(await isMoralisOhlcvEnabled())) {
    throw new Error('Moralis OHLC provider is disabled');
  }
}
```

Admin command examples:

```text
redis-cli SET feature:moralis_ohlcv_enabled false
redis-cli SET feature:moralis_ohlcv_enabled true
```

### 5. Add Temporary Backend Guards

Even before the database cache is complete, the backend must reject dangerous chart requests.

Recommended initial limits:

```text
1s max range: 5 minutes
10s max range: 2 hours
30s max range: 12 hours
1min max range: 24 hours
5min max range: 7 days
1h max range: 30 days
1d max range: 1 year

Max candles returned: 5000
Max synchronous Moralis pages: 1-3
```

Example guard:

```ts
const MAX_RANGE_MS_BY_TIMEFRAME: Record<string, number> = {
  '1s': 5 * 60 * 1000,
  '10s': 2 * 60 * 60 * 1000,
  '30s': 12 * 60 * 60 * 1000,
  '1min': 24 * 60 * 60 * 1000,
  '5min': 7 * 24 * 60 * 60 * 1000,
  '1h': 30 * 24 * 60 * 60 * 1000,
  '1d': 365 * 24 * 60 * 60 * 1000,
};

export function assertEmergencyRangeAllowed(params: {
  timeframe: string;
  from: Date;
  to: Date;
}) {
  const maxRangeMs = MAX_RANGE_MS_BY_TIMEFRAME[params.timeframe];
  if (!maxRangeMs) {
    throw new Error(`Unsupported timeframe: ${params.timeframe}`);
  }

  const requestedRangeMs = params.to.getTime() - params.from.getTime();
  if (requestedRangeMs <= 0) {
    throw new Error('Invalid chart range');
  }

  if (requestedRangeMs > maxRangeMs) {
    throw new Error(`Requested range is too large for ${params.timeframe}`);
  }
}
```

### 6. Add Basic Rate Limits

Temporary fixed-window limiter:

```ts
export async function enforceEmergencyChartRateLimit(params: {
  userId?: string;
  ip: string;
}) {
  const actor = params.userId ? `user:${params.userId}` : `ip:${params.ip}`;
  const key = `rate:chart:${actor}`;
  const count = await redis.incr(key);

  if (count === 1) {
    await redis.expire(key, 60);
  }

  if (count > 60) {
    throw new Error('Chart rate limit exceeded');
  }
}
```

## Temporary User Experience

Preferred beta behavior:

- Use Dexscreener for charts while backend caching is incomplete.
- If internal charts remain enabled, default to short visible ranges.
- If historical data is missing, return partial data instead of fetching unlimited history.
- Show a loading state when deeper history has been queued.

Example API response when backfill is pending:

```json
{
  "partial": true,
  "message": "Historical chart data is being prepared.",
  "candles": []
}
```

## Verification Checklist

Before declaring the emergency cutoff complete:

- Browser network tab shows no `deep-index.moralis.io` calls.
- Frontend bundle does not contain `MORALIS_API_KEY`.
- Old Moralis key is revoked if it was exposed.
- Moralis dashboard usage drops after deployment.
- Chart endpoint has request limits.
- There is a feature flag to disable Moralis provider.
- Logs show who is requesting charts and how often.

## Team Message

```text
We should disable Moralis-backed chart loading in beta now and use Dexscreener as fallback until the cache is built.

Current behavior lets users repeatedly trigger Moralis OHLC requests by opening charts or switching timeframes. One user can create real overage.

Immediate rules:
- Browser must not call Moralis.
- Moralis key must be backend-only.
- Rotate the key if it was client-side.
- Use Dexscreener or a bounded backend route.
- Add rate limits and range limits before re-enabling internal charts.
```
