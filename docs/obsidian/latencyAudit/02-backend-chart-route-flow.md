# 02 — Backend Route Flow

Relevant files:

- `moralisCacheSystem/src/routes/chartRoutes.ts`
- `moralisCacheSystem/src/services/chartService.ts`
- `moralisCacheSystem/src/timeframes.ts`

Endpoint:

```txt
GET /api/charts/ohlcv
```

## Query params from frontend

Typical request:

```txt
/api/charts/ohlcv
  ?chain=solana
  &pairAddress=8WDxqnNj2WUDXS3oqXrQsRuiuCaAyuf9qTgmd43XDdDv
  &timeframe=4h
  &requestedTimeframe=4h
  &currency=usd
  &from=...
  &to=...
  &visibleFrom=...
  &visibleTo=...
```

`refreshFromMoralis=true` is added when clicking the button.

## Route-level processing

In `chartRoutes.ts`:

1. Validate params with `zod`.
2. Clamp `to` to server-side `now`:

```ts
const to = new Date(Math.min(new Date(parsed.data.to).getTime(), now.getTime()));
```

3. Clamp visible range into `[from, to]`.
4. Compute backend effective timeframe:

```ts
const effectiveTimeframe = getEffectiveAdaptiveTimeframe({
  requestedTimeframe,
  from: visibleFrom,
  to: visibleTo,
});
```

For `7D + 4h`, this stays `4h`.

5. Calls:

```ts
getOhlcvForChart({
  ...,
  timeframe: effectiveTimeframe,
  maxProviderPages: 1,
  maxProviderFetches: 1,
});
```

## Important backend constraints

The route hard-codes:

```ts
maxProviderPages: 1
maxProviderFetches: 1
```

This means each backend HTTP request will do at most:

- 1 Moralis gap fetch
- 1 Moralis page

If the frontend sends multiple chunks, each chunk may make at most one provider fetch.

## Chart service flow

`getOhlcvForChart()` does this order:

1. Normalize pair address.
2. Validate range size via `assertChartRangeAllowed()`.
3. Enforce chart rate limits.
4. `touchPair()` in DB.
5. Read market history state.
6. Possibly queue full-history backfill.
7. Try Redis chart response cache.
8. If no good response cache, query candle DB.
9. Find missing ranges.
10. Find suspicious ranges.
11. Prioritize gaps that overlap `visibleFrom/visibleTo`.
12. If gaps exist, rate-limit provider miss.
13. Fetch Moralis for the first prioritized gap.
14. Upsert candles into DB.
15. Query DB again.
16. Build response and cache it if not partial.

## Direct Moralis timing

There is no intentional `sleep()` in this main request path.

The slow feeling comes from:

- frontend 600ms debounce
- over-wide prefetch window
- sequential frontend chunks
- backend doing old-history chunk before visible chunk
- Moralis/network latency
- previous one-by-one DB upserts, now changed to batched upserts

## Range validation

`assertChartRangeAllowed()` allows at most:

```txt
4h: 5000 candles
```

A single `2024-01-01 -> now` 4h request is slightly above or near this limit. The frontend avoids route failure by splitting into chunks, but the first chunk is usually pointless for a new token.
