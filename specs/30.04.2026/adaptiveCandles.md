# Adaptive Candles Spec - 30/04/2026

## Goal

Make chart loading safe, predictable, and useful for both:

- the local test frontend using `GET /api/charts/ohlcv`
- external API clients using Moralis-compatible OHLCV routes

Users and API clients may request any supported visible range and any supported candle size. The system must never spend unbounded Moralis CU, never fan out into hundreds of small-candle requests, and never fail only because the requested candle size is too granular for the requested range.

Instead, the system must adapt the requested candle size into a safe effective candle size.

## Problem To Fix

The current behavior has two separate failure modes:

1. Local frontend CU runaway:
   - The UI can request a very large range using `1min` candles.
   - The frontend may chunk that request into many backend calls.
   - The local backend may fetch Moralis pages for each chunk or gap.
   - This can consume thousands of CU every few seconds.

2. Chart request failed:
   - A client-side fuse rejects unsafe range and candle combinations.
   - This protects CU, but it makes normal chart usage fail.
   - Users expect zooming out to work; the candle size should adapt instead.

The permanent fix is adaptive candle resolution, not hard failure and not unbounded fetching.

## Scope

Applies to:

- `GET /api/charts/ohlcv`
- `GET /api/v2.2/pairs/:pairAddress/ohlcv`
- `GET /token/mainnet/pairs/:pairAddress/ohlcv`
- local-memory development mode in `src/localIndex.ts`
- production DB/Redis mode in `src/services/chartService.ts` and route handlers
- the local React test frontend in `client/src`

Does not require:

- synthetic or fake candles
- direct frontend calls to Moralis
- unlimited historical preloading

## Core Principle

The requested timeframe is a preference. The effective timeframe is what the system actually serves.

Example:

```text
requestedTimeframe = 1min
requestedRange = ALL
effectiveTimeframe = 12h
```

The UI and API responses must make this visible.

## Supported Ranges

Frontend named ranges:

```text
24H
7D
30D
3M
6M
1Y
ALL
```

API clients do not send range names. The backend derives the range bucket from `fromDate` and `toDate` or `from` and `to`.

## Supported Timeframes

The adaptive policy applies to:

```text
1min
5min
10min
30min
1h
4h
12h
1d
```

Other internally supported values, such as `1s`, `10s`, `30s`, `1w`, and `1M`, may remain supported where already implemented, but they are not required for the local test UI.

## Adaptive Timeframe Policy

Use the minimum effective candle size for the requested span.

```text
span <= 24h       minimum 1min
span <= 7d        minimum 5min
span <= 30d       minimum 30min
span <= 3 months  minimum 1h
span <= 6 months  minimum 4h
span <= 1 year    minimum 4h
span > 1 year     minimum 12h
```

If the requested timeframe is coarser than the minimum, keep the requested timeframe.

Examples:

```text
24H + 1min  -> 1min
24H + 1h    -> 1h
7D + 1min   -> 5min
30D + 5min  -> 30min
3M + 1min   -> 1h
6M + 1h     -> 4h
1Y + 1min   -> 4h
ALL + 1min  -> 12h
ALL + 1d    -> 1d
```

## Shared Algorithm

Create one shared adaptive resolution helper used by frontend policy and backend policy.

Pseudocode:

```ts
const timeframeOrder = ['1min', '5min', '10min', '30min', '1h', '4h', '12h', '1d'];

function getMinimumTimeframeForSpan(from: Date, to: Date): Timeframe {
  const spanMs = to.getTime() - from.getTime();

  if (spanMs <= 24 * HOUR) return '1min';
  if (spanMs <= 7 * DAY) return '5min';
  if (spanMs <= 30 * DAY) return '30min';
  if (spanMs <= 90 * DAY) return '1h';
  if (spanMs <= 365 * DAY) return '4h';
  return '12h';
}

function getEffectiveTimeframe(params: {
  requestedTimeframe: Timeframe;
  from: Date;
  to: Date;
}): Timeframe {
  const minimum = getMinimumTimeframeForSpan(params.from, params.to);
  return maxByTimeframeOrder(params.requestedTimeframe, minimum);
}
```

This helper must be deterministic. The same request should produce the same effective timeframe on frontend and backend.

## Frontend Requirements

### Range And Candle Selection

The user can click any named range and any candle size.

The UI must not disable candle buttons only because they are too granular. Instead, it may show them as requested but adapted.

Recommended UI states:

```text
Requested: 1min
Showing: 12h
```

or:

```text
1min requested, showing 12h
```

### Fetch Behavior

Before every chart fetch:

```ts
visibleRange = current chart range or current zoom range
effectiveTimeframe = getEffectiveTimeframe(requestedTimeframe, visibleRange.from, visibleRange.to)
fetch /api/charts/ohlcv with effectiveTimeframe
```

The frontend must not fetch `ALL` history when the selected range is `24H`, `7D`, `30D`, etc.

The frontend must not split a single user action into unbounded chunks. If chunking is needed for local UI responsiveness, the maximum number of chunks must be capped.

### Manual Zoom Behavior

The chart should support zooming out.

When the user zooms out:

1. Observe the chart's visible logical or time range.
2. Convert it to a requested `from` and `to`.
3. Compute `effectiveTimeframe`.
4. If the effective timeframe changes, refetch using the coarser timeframe.
5. If the user zooms back in far enough, the UI may refetch using a finer effective timeframe.

The UI must debounce zoom-driven fetches.

Recommended debounce:

```text
300ms to 750ms after the visible range stops changing
```

### Frontend CU Protection

The frontend must never trigger repeated provider-spending backend requests while the user is actively zooming or panning.

Rules:

- Debounce zoom/pan fetches.
- Do not request the same range/timeframe repeatedly while a request is in flight.
- Abort stale in-flight requests when the selected pair, chain, range, or requested timeframe changes.
- Cache recent chart responses client-side by `(chain, pairAddress, effectiveTimeframe, from, to)` during the session.

### Frontend Response Metadata

The frontend response type should distinguish:

```ts
requestedTimeframe: Timeframe;
timeframe: Timeframe; // effective timeframe
effectiveTimeframe: Timeframe; // optional alias if clearer
source: 'cache' | 'cache+moralis' | 'partial' | 'cache-only' | 'demo';
partial: boolean;
candles: ChartCandle[];
```

`timeframe` may remain the effective timeframe for backward compatibility.

## Internal Chart API Requirements

Route:

```text
GET /api/charts/ohlcv
```

Input:

```text
chain
pairAddress
timeframe
currency
from
to
```

Normalization:

```ts
requestedTimeframe = request.timeframe
effectiveTimeframe = getEffectiveTimeframe({ requestedTimeframe, from, to })
```

The service must use `effectiveTimeframe` for:

- range validation
- cache key
- database candle lookup
- missing gap detection
- Moralis fetch
- response candles

The service must retain `requestedTimeframe` in response metadata.

Response:

```json
{
  "chain": "base",
  "pairAddress": "0x...",
  "requestedTimeframe": "1min",
  "timeframe": "12h",
  "currency": "usd",
  "from": "2024-01-01T00:00:00.000Z",
  "to": "2026-04-30T00:00:00.000Z",
  "source": "partial",
  "partial": true,
  "candles": []
}
```

Headers:

```http
x-requested-timeframe: 1min
x-effective-timeframe: 12h
x-cache-source: cache | cache+moralis | partial | cache-only | demo
x-moralis-cu-used: 0 | 150 | ...
```

## Moralis-Compatible API Requirements

Routes:

```text
GET /api/v2.2/pairs/:pairAddress/ohlcv
GET /token/mainnet/pairs/:pairAddress/ohlcv
```

These routes must remain Moralis-compatible in shape, but they may adapt the candle size to protect the cache proxy.

Input:

```text
timeframe
fromDate
toDate
limit
cursor
currency
chain
```

Normalization order:

1. Validate API key.
2. Parse dates and requested timeframe.
3. Decode cursor if present.
4. Compute requested span from original `fromDate` and `toDate`.
5. Compute `effectiveTimeframe`.
6. Clamp `limit` to `1..1000`.
7. Compute a safe page window using the effective timeframe.
8. Fetch/cache/return candles using the effective timeframe.

Pseudocode:

```ts
requestedTimeframe = request.timeframe;
effectiveTimeframe = getEffectiveTimeframe({
  requestedTimeframe,
  from: request.fromDate,
  to: request.toDate,
});

effectiveLimit = clamp(request.limit ?? 100, 1, 1000);
pageFrom = cursor?.fromDate ?? request.fromDate;
pageTo = min(request.toDate, pageFrom + effectiveLimit * effectiveTimeframeMs);
```

Response body remains Moralis-compatible:

```json
{
  "cursor": "...",
  "result": [
    {
      "timestamp": "2026-04-29T00:00:00.000Z",
      "open": 1,
      "high": 1,
      "low": 1,
      "close": 1,
      "volume": 100,
      "trades": 10
    }
  ]
}
```

Response headers:

```http
x-requested-timeframe: 1min
x-effective-timeframe: 12h
x-cache-source: cache | cache+moralis | partial | cache-only
x-moralis-cu-used: 0 | 150 | ...
x-effective-limit: 300
x-page-from: 2026-04-01T00:00:00.000Z
x-page-to: 2026-04-07T06:00:00.000Z
```

Cursor rules:

- Cursor must encode the next safe `fromDate`.
- Cursor should also encode `effectiveTimeframe` or enough metadata to reject inconsistent cursor usage.
- If a cursor is used with a different pair, chain, currency, or effective timeframe, return `400 Invalid cursor`.

## CU And Provider Fetch Limits

All routes must enforce these limits:

```text
max limit per response: 1000
max Moralis pages per request: 1
max cache-miss requests per external API key per minute
max CU per external API key per day
max local-memory Moralis pages per chart request: 1
```

Large ranges must be handled by coarser candles, cursors, partial responses, or cached-only responses. They must never be handled by unlimited synchronous backfills.

## Cache Behavior

Cache keys must use the effective timeframe, not the requested timeframe.

Example:

```text
requestedTimeframe=1min
effectiveTimeframe=12h
cache key includes 12h
```

This prevents duplicate cache entries for different requested timeframes that adapt to the same effective timeframe.

Recommended cache key dimensions:

```text
chain
pairAddress
effectiveTimeframe
currency
from
to
```

## Missing Data Behavior

When Moralis is configured, do not synthesize fake candles.

Allowed behavior:

- return real cached candles
- fetch at most one missing Moralis page
- store returned real candles
- mark response `partial: true` if gaps remain
- return `source: partial` or `source: cache-only`

Disallowed behavior:

- generating fake candles to fill real-data gaps
- labeling fake data as ready cache
- hiding gaps as `source: demo` when a Moralis key exists

Demo candles are only allowed when explicitly running a demo mode with no Moralis key and should be clearly labeled `source: demo`.

## Local-Memory Mode Requirements

Local-memory mode is for UI testing, but it still must protect CU.

Requirements:

- Same adaptive timeframe policy as production.
- Same max one Moralis page per chart request.
- No synthetic gap filling when `MORALIS_API_KEY` exists.
- Persistent local usage tracking in:
  - `.local-proxy-usage.json`
  - `.local-proxy-usage.jsonl`
- Response metadata must show requested and effective timeframe.
- If missing gaps remain after one Moralis page, return `partial: true`.

## External API Key Requirements

External API clients must provide:

```http
X-API-Key: mcs_live_...
```

API keys must remain:

- generated by admin endpoint
- stored hashed only
- revocable
- scoped
- independently rate-limited
- budget-limited by CU

Adaptive candles must not bypass these limits.

## Error Policy

Do not error only because a range is large for the requested timeframe.

Adapt instead.

Still return errors for:

- missing API key
- invalid API key
- missing pair address
- unsupported timeframe
- invalid dates
- `to <= from`
- malformed cursor
- cursor reused with incompatible request metadata

## Observability

Every chart response should make adaptation visible.

Internal API fields:

```json
{
  "requestedTimeframe": "1min",
  "timeframe": "12h",
  "source": "partial",
  "partial": true
}
```

External API headers:

```http
x-requested-timeframe: 1min
x-effective-timeframe: 12h
x-cache-source: partial
x-moralis-cu-used: 150
x-effective-limit: 1000
x-page-from: ...
x-page-to: ...
```

Logs should include:

```text
chain
pairAddress
requestedTimeframe
effectiveTimeframe
from
to
source
partial
moralisPages
estimatedCu
```

## Acceptance Criteria

### Frontend

- `24H + 1min` loads successfully and shows `1min`.
- `7D + 1min` loads successfully and shows `5min`.
- `30D + 1min` loads successfully and shows `30min`.
- `3M + 1min` loads successfully and shows `1h`.
- `6M + 1min` loads successfully and shows `4h`.
- `1Y + 1min` loads successfully and shows `4h`.
- `ALL + 1min` loads successfully and shows `12h`.
- Manual zoom-out never triggers unbounded `1min` chunk fetching.
- Manual zoom-out adapts to coarser candles when the visible span crosses thresholds.
- Manual zoom-in may adapt back to finer candles.
- UI clearly displays when requested and effective timeframes differ.
- The chart does not show `Chart request failed` for valid large ranges.

### Internal API

- `/api/charts/ohlcv` adapts large ranges instead of rejecting them.
- A request for `from=2024-01-01`, `to=now`, `timeframe=1min` returns `timeframe=12h`.
- Internal response includes `requestedTimeframe`.
- Internal response uses effective timeframe for cache, DB, gap detection, and provider fetches.
- No single request fetches more than one Moralis page in local-memory mode.
- Missing data returns `partial: true`, not fake candles.

### External API

- External request for a one-year `1min` range returns `200`, not an oversized-range error.
- The response is Moralis-compatible.
- Headers include `x-requested-timeframe` and `x-effective-timeframe`.
- `x-effective-timeframe` is coarser when required.
- A large `1min` request cannot spend more than one Moralis page.
- Repeated identical requests are served from cache when possible.
- Invalid API keys return `401`.
- Unsupported timeframes return `400`.
- Malformed cursors return `400`.

### CU Protection

- Fully zooming out on `1min` cannot consume thousands of CU every few seconds.
- Rapid zooming or panning is debounced.
- Stale requests are aborted or ignored.
- Usage counters reflect actual Moralis pages only.
- No synthetic candles are counted as real provider data.

## Implementation Plan

1. Add shared adaptive timeframe utilities.
2. Update frontend fetch path to use requested and effective timeframe.
3. Update chart zoom handling to debounce visible range changes and refetch adapted data.
4. Update `/api/charts/ohlcv` to adapt requested timeframe before service calls.
5. Update Moralis-compatible routes to adapt timeframe before page-window calculation.
6. Update cache keys and response metadata to use effective timeframe.
7. Remove synthetic gap filling when Moralis is configured.
8. Add tests for each range/timeframe threshold.
9. Add tests for external API headers and one-page Moralis cap.
10. Add tests for local-memory partial responses.

## Non-Goals

- Infinite candle history at `1min`.
- Perfect TradingView-style lazy loading in this iteration.
- Fake data in production or Moralis-configured local mode.
- Preserving exact requested timeframe when it would create unsafe request sizes.
