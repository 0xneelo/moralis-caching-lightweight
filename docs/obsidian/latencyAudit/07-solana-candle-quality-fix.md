# 07 — Solana Candle Quality Fix

## Problem

URL:

```txt
/solana/8WDxqnNj2WUDXS3oqXrQsRuiuCaAyuf9qTgmd43XDdDv?range=48H&timeframe=1h
```

showed corrupted candles even after refresh.

## Cause

Moralis Solana OHLCV can return malformed higher-timeframe candles for new pairs. Observed examples:

- `1d` high/low inverted or nonsensical
- `4h` high/low inverted
- `1h` sometimes has repeated pinned open/close values depending on request window

The chart cache/database then stored those malformed aggregate candles.

## Fix

File:

```txt
moralisCacheSystem/src/moralis.ts
```

For Solana high timeframes, we now fetch `5min` candles and aggregate internally:

```txt
1h  <- 5min
4h  <- 5min
6h  <- 5min
12h <- 5min
1d  <- 5min
```

This avoids trusting Moralis' broken higher-timeframe Solana aggregates.

Aggregation rules:

```txt
open   = first source candle open
close  = last source candle close
high   = max(open/high/low/close of all source candles)
low    = min(open/high/low/close of all source candles)
volume = sum volume
trades = sum trades
```

## Cache invalidation

File:

```txt
moralisCacheSystem/src/cache.ts
```

Response cache version bumped:

```txt
v4 -> v5
```

## Corrupt DB detection

Files:

```txt
moralisCacheSystem/src/candleQuality.ts
moralisCacheSystem/src/services/chartService.ts
```

Suspicious OHLC detection now applies to:

```txt
1h, 4h, 6h, 12h, 1d
```

instead of only `1d`.

This means old corrupted cached DB candles can trigger a Moralis refresh even when no timestamps are missing.
