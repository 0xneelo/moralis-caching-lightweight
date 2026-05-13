# External Chart Countback Integration Guide

## Purpose

The external chart should stop guessing how many historical time ranges it needs to fetch to fill the visible viewport.

The cache now exposes a countback endpoint. Instead of asking:

```text
Give me candles between from and to.
```

the external chart can ask:

```text
Give me the latest N non-zero-volume cached candles before this timestamp.
```

This matches the practical behavior needed by chart UIs: render approximately N bars on screen without repeatedly probing older ranges.

## Endpoint

```text
GET /api/token/ohlc/countback
```

Use the same cache host/base URL that the external frontend already uses for the Moralis cache.

Example local URL:

```text
http://localhost:3001/api/token/ohlc/countback
```

Example tunnel URL:

```text
https://<cloudflare-tunnel-host>/api/token/ohlc/countback
```

## Authentication

Send the existing external cache API key:

```http
X-API-Key: <external-cache-api-key>
```

Do not expose this key directly from browser code if the external app has a backend proxy. Prefer calling this cache endpoint from your backend proxy and forwarding the response to the browser.

## Query Parameters

| Param | Required | Example | Notes |
|---|---:|---|---|
| `pairAddress` | yes | `0x3eB2...f821` | Must be the pair address, not token address. |
| `chainId` | yes | `base`, `0x2105`, `8453` | `0x2105` and `8453` normalize to `base`; `0x1` and `1` normalize to `eth`. |
| `to` | yes | `1777343400` | Unix timestamp in seconds. Countback returns candles at or before this timestamp. |
| `resolution` | yes | `60` | TradingView-style resolution. See mapping below. |
| `countBack` | yes | `300` | Target number of non-zero-volume candles. Server clamps to max `1000`. |
| `currency` | no | `usd` | Defaults to cache server `DEFAULT_CURRENCY`. Usually use `usd`. |

## Resolution Mapping

| External `resolution` | Cache timeframe |
|---|---|
| `1` | `1min` |
| `5` | `5min` |
| `10` | `10min` |
| `30` | `30min` |
| `60` | `1h` |
| `240` | `4h` |
| `360` | `6h` |
| `720` | `12h` |
| `1D` or `D` | `1d` |
| `1W` or `W` | `1w` |
| `1M` or `M` | `1M` |

## Example Request

```http
GET /api/token/ohlc/countback?chainId=0x2105&pairAddress=0x3eB2a8015dE1419a5089dAb37b0056F0fc24f821&resolution=60&to=1777343400&countBack=300&currency=usd
X-API-Key: mcs_live_...
```

## Response Shape

The response includes both TradingView-style arrays and a raw `result` array.

```json
{
  "s": "ok",
  "t": [1777338000, 1777341600],
  "o": [1.5, 2.0],
  "h": [2.5, 3.0],
  "l": [1.4, 1.8],
  "c": [2.0, 2.7],
  "v": [150, 175],
  "result": [
    {
      "timestamp": "2026-04-28T01:00:00.000Z",
      "open": 1.5,
      "high": 2.5,
      "low": 1.4,
      "close": 2.0,
      "volume": 150,
      "trades": 12
    },
    {
      "timestamp": "2026-04-28T02:00:00.000Z",
      "open": 2.0,
      "high": 3.0,
      "low": 1.8,
      "close": 2.7,
      "volume": 175,
      "trades": 14
    }
  ]
}
```

Candles are ordered oldest-to-newest. Candles with `volume = 0` or missing/null volume are filtered out by this endpoint.

## Response Headers

Read these headers for debugging and telemetry:

| Header | Meaning |
|---|---|
| `x-cache-source` | `cache` when enough cached candles were available, `partial` when fewer than requested were available. |
| `x-requested-timeframe` | Internal timeframe mapped from `resolution`. |
| `x-effective-timeframe` | Same as requested timeframe for countback. |
| `x-effective-limit` | Clamped `countBack`, max `1000`. |
| `x-countback-returned` | Number of candles actually returned. |
| `x-page-from` | Timestamp of first returned candle, empty if none. |
| `x-page-to` | The requested `to` timestamp as ISO. |
| `x-moralis-cu-used` | Always `0` for this endpoint. Countback does not synchronously hit Moralis. |

## Empty Or Partial Responses

If no candles are cached yet:

```json
{
  "s": "no_data",
  "t": [],
  "o": [],
  "h": [],
  "l": [],
  "c": [],
  "v": [],
  "result": []
}
```

If fewer than `countBack` non-zero-volume candles are cached, the server returns the available candles and sets:

```http
x-cache-source: partial
x-countback-returned: <less than countBack>
x-moralis-cu-used: 0
```

The cache server schedules background warming when data is missing. The frontend should render the partial data and may retry after a short delay if it needs more candles.

Recommended retry behavior:

1. If `x-cache-source` is `partial` and `x-countback-returned` is `0`, show a loading or empty state.
2. Retry once after `2-5s`.
3. Avoid tight polling loops.
4. Do not fan out many older range requests as a fallback.

## Integration Flow

### Initial Chart Load

1. Decide the approximate number of bars needed for the viewport.
   - Desktop: usually `250-500`.
   - Mobile: usually `120-250`.
2. Pick `to = Math.floor(Date.now() / 1000)`.
3. Call `/api/token/ohlc/countback`.
4. Render the returned arrays directly.
5. If fewer candles are returned, render what you have and optionally retry once after the cache warms.

### Panning Left

When the user scrolls/pans left and needs older candles:

1. Take the first visible candle timestamp.
2. Set `to = firstVisibleTimestamp - 1`.
3. Call countback again with the same `resolution` and desired `countBack`.
4. Prepend returned candles to local chart state.
5. De-duplicate by timestamp.

### Resolution Change

When the user changes chart resolution:

1. Clear local candles for the old resolution.
2. Call countback with the new `resolution`.
3. Render the new response as a separate series.

Do not mix candles from different resolutions in the same local array.

## Example TypeScript Client

```ts
type CountbackResponse = {
  s: 'ok' | 'no_data';
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
  result: Array<{
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
    trades?: number;
  }>;
};

async function fetchCountback(params: {
  baseUrl: string;
  apiKey: string;
  pairAddress: string;
  chainId: string;
  resolution: string;
  to: number;
  countBack: number;
}) {
  const url = new URL('/api/token/ohlc/countback', params.baseUrl);
  url.searchParams.set('pairAddress', params.pairAddress);
  url.searchParams.set('chainId', params.chainId);
  url.searchParams.set('resolution', params.resolution);
  url.searchParams.set('to', String(params.to));
  url.searchParams.set('countBack', String(params.countBack));
  url.searchParams.set('currency', 'usd');

  const response = await fetch(url, {
    headers: {
      'X-API-Key': params.apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Countback request failed: ${response.status}`);
  }

  return {
    body: (await response.json()) as CountbackResponse,
    meta: {
      cacheSource: response.headers.get('x-cache-source'),
      returned: Number(response.headers.get('x-countback-returned') ?? 0),
      limit: Number(response.headers.get('x-effective-limit') ?? params.countBack),
    },
  };
}
```

## Rendering Notes

- Use `t/o/h/l/c/v` arrays if your chart adapter expects TradingView-style data.
- Use `result` if your app already maps Moralis-style candle objects.
- Do not rewrite `open = previous.close` unless that is a deliberate visual mode. It will make the chart differ from the cache reference.
- De-duplicate candles by timestamp when prepending older countback results.
- Keep one candle array per `pairAddress + chainId + resolution + currency`.

## What Not To Do

Do not:

- sequentially request arbitrary older ranges until enough non-empty candles appear
- ignore `chainId` normalization
- send token address instead of pair address
- assume `countBack` always returns exactly `countBack` candles
- expect zero-volume filler candles from this endpoint
- poll aggressively when cache is still warming
- fall back to direct Moralis from the external frontend

## Error Handling

| Status | Cause | Action |
|---:|---|---|
| `400` | Missing/invalid query param or unsupported resolution | Fix request construction. |
| `401` | Missing/invalid `X-API-Key` | Check proxy/key config. |
| `429` | External key request limit exceeded | Back off and retry later. |
| `500` | Cache server error | Log request URL, headers, and response body for backend debugging. |

## Migration Plan

1. Add a countback client wrapper in the external frontend/backend proxy.
2. Replace initial chart bootstrap range calls with one countback call.
3. Replace left-scroll historical loading with countback calls using `to = firstTimestamp - 1`.
4. Keep existing Moralis-compatible range endpoint only for flows that truly need exact range windows.
5. Add request logging for:
   - pair address
   - chain ID
   - resolution
   - requested countBack
   - returned count
   - `x-cache-source`
6. Test with active and sparse markets.

## Quick Test Request

```bash
curl "$CACHE_BASE_URL/api/token/ohlc/countback?chainId=0x2105&pairAddress=0x3eB2a8015dE1419a5089dAb37b0056F0fc24f821&resolution=60&to=$(date +%s)&countBack=300&currency=usd" \
  -H "X-API-Key: $CACHE_API_KEY"
```

Expected:

- HTTP `200`
- `x-moralis-cu-used: 0`
- `x-effective-limit: 300`
- `s: "ok"` if cached candles exist, otherwise `s: "no_data"`
