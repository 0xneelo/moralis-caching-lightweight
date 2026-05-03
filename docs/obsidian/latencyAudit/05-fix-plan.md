# 05 — Fix Plan

## Goal

When user opens:

```txt
/solana/8WDxqnNj2WUDXS3oqXrQsRuiuCaAyuf9qTgmd43XDdDv?range=7D&timeframe=4h
```

The app should:

1. render cache hits in milliseconds
2. if visible candles are missing, call Moralis for the visible gap quickly
3. not scan/fetch irrelevant old history first
4. progressively backfill older history in background only after visible chart is usable

## P0 — Stop expanding `7D + 4h` to all history

Change `getPrefetchWindow()`.

Current behavior:

```txt
visible: 7D
prefetch: up to ~833D for 4h
```

Recommended behavior:

```txt
visible: 7D
prefetch: visible range + modest padding, e.g. 1x to left/right or capped to 30D
```

Example policy:

```ts
const visibleSpanMs = visibleTo - visibleFrom;
const maxPaddingMs = Math.min(visibleSpanMs, 30 * dayMs);
from = visibleFrom - maxPaddingMs;
to = visibleTo;
```

For `7D`, this fetches at most `14D`, not 833D.

For `ALL`, allow broad history, but still prioritize visible/recent chunk first.

## P0 — Fetch visible chunk first

If the client still splits requests, sort chunks so the visible chunk is first.

Better:

- request visible range first
- then request background prefetch range separately

This gives the user candles quickly.

## P1 — Parallelize or stage chunks

Current:

```ts
for chunk await fetch(chunk)
```

Option A: parallelize with low concurrency:

```ts
await Promise.all(chunks.map(...))
```

Option B, better UX:

1. fetch visible range
2. render chart
3. background fetch prefetch range

## P1 — Do not block intraday visible fetch on daily full-history bootstrap

Current logic can block non-daily provider fetches until 1d history is complete.

For interactive charting:

```txt
visible intraday gaps should fetch immediately
full daily history should be a background concern
```

Recommendation:

- remove `requiresDailyBootstrap` as a blocker for visible range fetches
- keep daily bootstrap as background optimization

## P1 — Manual refresh should refresh visible window first

`Refresh From Moralis` should use:

```txt
visibleRange
```

not expanded `loadRange`.

If we want a deep refresh, add a separate admin/debug button.

## P1 — Add timing headers / trace logs

Add backend timing fields:

```txt
x-timing-cache-read-ms
x-timing-gap-detect-ms
x-timing-moralis-ms
x-timing-db-upsert-ms
x-timing-total-ms
```

Also include in JSON during dev:

```ts
debugTiming: {
  totalMs,
  dbLookupMs,
  missingRangeMs,
  moralisMs,
  dbUpsertMs,
  finalDbLookupMs
}
```

This will prove whether DB/cache is actually slow or whether windowing/provider logic is slow.

## P2 — Separate debounce behavior

Use separate debounces:

```txt
pair input typing: 600ms
range/timeframe clicks: 0ms or 50ms
zoom/pan: 500ms
```

## P2 — Stabilize response cache keys

Cache keys should use aligned candle-boundary `from/to`, not moving wall-clock timestamps.

Also consider skipping full response cache for live current candle and relying on candle DB + short in-memory TTL.

## Suggested implementation order

1. Fix `getPrefetchWindow()` cap/policy.
2. Make manual refresh use visible window.
3. Remove daily bootstrap blocker for visible non-daily requests.
4. Add timing instrumentation.
5. Stage visible fetch before prefetch.
6. Reduce button-click debounce.
7. Improve response cache key stability.

## Expected user-visible improvement

For `7D + 4h` on a new Solana token:

Current likely path:

```txt
600ms debounce
old-history chunk
empty/provider/dexscreener logic
recent chunk
Moralis
render
```

Target path:

```txt
0-50ms button debounce
visible 7D cache lookup
Moralis for visible gap if needed
render
background prefetch/backfill
```

This should feel near-instant on cache hit and usually 1 network roundtrip on cache miss.
