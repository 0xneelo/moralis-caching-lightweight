# 04 — Current Latency Findings

## Finding 1 — `7D + 4h` expands to near-all-history

Severity: **P0 latency/design bug**

Location:

```txt
moralisCacheSystem/client/src/api.ts
getPrefetchWindow()
```

For `4h`, the frontend allows a max prefetch window of:

```txt
5000 candles * 4 hours = ~833 days
```

For a visible `7D` range, the current formula chooses the older of:

```txt
visibleFrom = now - 7 days
oldestSafeFrom = now - 833 days
```

So it expands a 7-day chart to almost all history.

Impact:

- request payload windows are much larger than the user selected
- cache response keys become broad and harder to reuse
- backend does unnecessary old-history cache/gap work
- frontend may split into multiple sequential chunks
- new tokens waste time asking for data before they existed

## Finding 2 — Chunks are fetched sequentially

Severity: **P1 latency bug**

Location:

```txt
moralisCacheSystem/client/src/api.ts
fetchChartCandles()
```

Current logic:

```ts
for (const chunk of chunks) {
  responses.push(await fetchChartCandlesOnce(...));
}
```

This means chunk 2 cannot start until chunk 1 finishes.

For a new token:

```txt
chunk 1: 2024-01 -> 2026-04   likely empty/useless
chunk 2: 2026-04 -> now        contains visible data
```

The user waits for the useless old chunk before the visible chunk starts.

## Finding 3 — 600ms frontend debounce applies to button clicks

Severity: **P2 latency polish**

Location:

```txt
moralisCacheSystem/client/src/App.tsx
CHART_FETCH_DEBOUNCE_MS = 600
```

This is good for typing a pair address, but suboptimal for range/timeframe buttons.

Clicking `7D` or `4h` should probably fetch immediately, while pair address input can remain debounced.

## Finding 4 — Redis response cache key includes exact moving `to`

Severity: **P1 cache effectiveness issue**

Location:

```txt
moralisCacheSystem/src/cache.ts
buildChartCacheKey()
```

The key includes exact ISO `from` and `to`.

For live charts, if `to` changes every request, response cache misses even if the requested candle buckets are identical.

This is partially mitigated by frontend bucket normalization, but route clamping to server `now` can still change response `to` behavior.

Better:

- cache by aligned candle bucket range
- or cache only immutable closed-candle segments
- or use candle-table cache as primary and reduce full response cache reliance

## Finding 5 — Backend full-history bootstrap can block non-daily fetches

Severity: **P1/P2 product behavior**

Location:

```txt
moralisCacheSystem/src/services/chartService.ts
requiresDailyBootstrap
```

Logic:

```ts
const requiresDailyBootstrap = !isDailyRequest && !dailyHistoryComplete;
```

If daily history is not complete, non-daily requests can be blocked from Moralis:

```ts
provider_fetch_blocked_until_1d_complete
```

This can make an intraday request wait on / depend on daily bootstrap, which is not ideal for responsive charting.

For a user asking `7D + 4h`, the app should fetch 4h visible candles immediately, not wait for daily full-history state.

## Finding 6 — Manual refresh still uses same broad window

Severity: **P1 UX issue**

Clicking `Refresh From Moralis` sets:

```ts
refreshFromMoralis: true
```

But it uses the same `loadRange`, which may be expanded far beyond visible range.

For a manual refresh, user intent is likely:

```txt
refresh the currently visible chart window first
```

not:

```txt
refresh 833 days of 4h candle capacity
```

## Finding 7 — Solana/Moralis edge cases for new tokens

Severity: **P1 provider correctness**

Observed behavior:

- Asking Moralis for a new Solana pair from `2024-01-01` returned empty.
- Asking from the actual pair creation date returned candles.

We added a Dexscreener `pairCreatedAt` retry for Solana empty responses.

Remaining concern:

The frontend should avoid asking pre-token history in the first place after metadata gives `pairCreatedAt`.
