# External Timeframe Countback Solution

## Problem

The external chart currently asks the cache by time range. That forces the external frontend to guess how many ranges to request before it has enough visible non-empty candles. The guess is unreliable because the number of stored candles depends on:

- market activity and zero-volume gaps
- requested resolution/timeframe
- requested visible range
- how much of the market history is already cached

This creates slow first loads and can scale poorly when many users open charts at the same time. The external frontend should not have to sequentially probe one range after another just to fill the visible chart.

## Goal

Add a cache API that behaves like a countback endpoint: the client asks for a target number of bars ending at a timestamp, and the cache returns up to that many non-zero-volume stored candles in the requested resolution. This is not a Moralis-compatible endpoint; it is an internal cache convenience endpoint for our external frontend.

## Final API Contract

Endpoint:

```text
GET /api/token/ohlc/countback
```

Authentication:

```text
X-API-Key: <external cache key>
```

Query:

```text
pairAddress=<pair address>
chainId=<base | eth | 8453 | 0x2105 | 1 | 0x1>
to=<unix seconds>
resolution=<1 | 5 | 10 | 30 | 60 | 240 | 360 | 720 | 1D | 1W | 1M>
countBack=<1..1000>
currency=<usd | native> optional, defaults to DEFAULT_CURRENCY
```

Response:

```json
{
  "s": "ok",
  "t": [1714435200],
  "o": [1.0],
  "h": [1.2],
  "l": [0.9],
  "c": [1.1],
  "v": [100],
  "result": [
    {
      "timestamp": "2026-04-30T00:00:00.000Z",
      "open": 1.0,
      "high": 1.2,
      "low": 0.9,
      "close": 1.1,
      "volume": 100
    }
  ]
}
```

Headers:

```text
x-cache-source: cache | partial
x-requested-timeframe: <timeframe>
x-effective-timeframe: <timeframe>
x-effective-limit: <countBack>
x-page-to: <ISO to timestamp>
x-countback-returned: <returned candle count>
x-moralis-cu-used: 0
```

## Behavior

1. Normalize `chainId` and pair address so `base` and `0x2105` use the same cache namespace.
2. Map TradingView/Dexscreener-style `resolution` to the internal OHLCV timeframe.
3. Clamp `countBack` to `1..1000`.
4. Query cached candles at or before `to`, filtering out `volume = 0` / null-volume candles, ordered newest first, limited to `countBack`.
5. Return candles oldest-to-newest for chart rendering.
6. Do not make synchronous Moralis calls from this countback endpoint.
7. If fewer than `countBack` candles are available, enqueue a bounded background backfill window and return the cached partial result immediately.

## Why No Synchronous Moralis Fetch

The problem is first-load latency and scalability. Moving the sequential probing from the browser to the API would still create unpredictable request cost. The countback endpoint must be fast and bounded. Cache misses should schedule backfill work instead of blocking the user request.

The existing Moralis-compatible range endpoints remain available for clients that need exact range/cursor semantics.

## Acceptance Criteria

- External clients can request `countBack=N` without guessing ranges.
- Returned candles are non-zero-volume stored candles only, ordered oldest-to-newest.
- The endpoint accepts `chainId=0x2105` and reads the same cache namespace as `base`.
- The endpoint clamps abusive `countBack` values to `1000`.
- Empty or insufficient cache does not trigger a long synchronous provider fetch.
- Empty or insufficient cache enqueues background backfill work.
- Existing Moralis-compatible endpoints keep their current one-page fetch behavior and tests stay green.
- The solution is covered by backend tests, typecheck, and build.
