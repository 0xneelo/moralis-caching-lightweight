# Latency Audit — Moralis Charting

This folder documents the exact chart loading path for URLs such as:

```txt
http://localhost:5173/solana/8WDxqnNj2WUDXS3oqXrQsRuiuCaAyuf9qTgmd43XDdDv?range=7D&timeframe=4h
```

## Files

1. [[01-click-to-network-flow]] — Browser/client flow after selecting range + candle size.
2. [[02-backend-chart-route-flow]] — Fastify route and chart service behavior.
3. [[03-moralis-cache-flow]] — Cache lookup, gap detection, locks, Moralis fetch.
4. [[04-current-latency-findings]] — Concrete bottlenecks found in this repository.
5. [[05-fix-plan]] — Recommended fixes, ordered by impact.
6. [[06-implemented-latency-fixes]] — Fixes implemented from the audit.
7. [[07-solana-candle-quality-fix]] — Fix for corrupted Solana higher-timeframe candles.

## High-level finding

The slow behavior is very likely not because the DB cache lookup itself is slow. The bigger issue is that the frontend often requests a much larger prefetch window than the selected visible range.

For `range=7D&timeframe=4h`, the current frontend can expand the request from **7 days** to nearly **all history since 2024-01-01**, then split that into sequential chunks. That makes the app do unnecessary cache scans / gap checks / provider logic before it reaches the actually visible 7-day window.
