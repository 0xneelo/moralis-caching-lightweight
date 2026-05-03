# 06 — Implemented Latency Fixes

Date: 2026-05-03

## Implemented

### 1. Capped normal prefetch windows

File:

```txt
moralisCacheSystem/client/src/api.ts
```

`getPrefetchWindow()` no longer expands normal windows like `7D + 4h` to ~833 days.

New behavior:

- visible range is padded modestly
- padding is capped to 30 days and half the max provider window
- huge/ALL windows can still use the max provider window

For `7D + 4h`, expected request is now roughly:

```txt
14 days instead of ~833 days
```

### 2. Prioritize visible chunks

File:

```txt
moralisCacheSystem/client/src/api.ts
```

If a request still splits into multiple chunks, chunks overlapping the visible range are fetched first.

This prevents old-history chunks from blocking the visible chart.

### 3. Manual refresh uses visible range

File:

```txt
moralisCacheSystem/client/src/App.tsx
```

`Refresh From Moralis` now refreshes the visible chart window first instead of the expanded prefetch window.

### 4. Lower chart fetch debounce

File:

```txt
moralisCacheSystem/client/src/App.tsx
```

Changed:

```txt
600ms -> 150ms
```

This improves range/timeframe click responsiveness.

### 5. Do not block intraday fetches on daily bootstrap

File:

```txt
moralisCacheSystem/src/services/chartService.ts
```

Interactive non-daily chart requests can now fetch missing visible candles without waiting for daily full-history bootstrap.

### 6. Do not show warmup overlay for ordinary visible cache misses

File:

```txt
moralisCacheSystem/src/services/chartService.ts
```

A normal `7D + 4h` request that has candles but incomplete full history should render candles instead of hiding them behind `99% warming`.

### 7. More stable response cache keys

File:

```txt
moralisCacheSystem/src/cache.ts
```

Response cache keys now align `from/to` to candle boundaries instead of using exact moving timestamps.

Cache version bumped:

```txt
v3 -> v4
```

## Quick validation

A local direct API request for the `7D + 4h` Solana token path returned:

```txt
source: cache+moralis
candles: 4
historyWarming: false
historyComplete: false
latency: ~334ms on first v4 response
```

A subsequent aligned cache hit returned much faster.
