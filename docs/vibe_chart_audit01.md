# VibeCaps Chart Troubleshooting Plan

## Goal

Find why the external VibeCaps chart does not match our local/cache reference chart.

Start with request/response facts before changing chart rendering.

## First Checks

### 1. Confirm The Active Route

Verify the frontend is calling our Cloudflare cache URL, not direct Moralis and not only its own local proxy.

Expected upstream base:

```text
https://prove-currently-ticket-afford.trycloudflare.com
```

Expected EVM path:

```text
/api/v2.2/pairs/:pairAddress/ohlcv
```

Expected header:

```text
X-API-Key: <shared cache api key>
```

If browser DevTools only shows:

```text
http://localhost:3000/api/token/ohlc
```

then inspect the server-side proxy logs to confirm that proxy forwards to our Cloudflare URL.

## 2. Log One Complete Request

For one chart load, record:

```text
pairAddress
chain / chainId
requested range from/to
requested resolution
limit
full upstream URL
status code
```

Also record these response headers from our cache:

```text
x-requested-timeframe
x-effective-timeframe
x-cache-source
x-page-from
x-page-to
x-moralis-cu-used
```

These headers tell us whether the cache adapted the candle size, served cache only, or spent Moralis CU.

## 3. Verify Cursor Handling

Our Moralis-compatible API can return:

```json
{
  "cursor": "...",
  "result": []
}
```

If `cursor` is present, the client must either:

- request the next page using `cursor`, or
- intentionally stop and render a partial chart.

If the proxy ignores `cursor`, it may only render one safe page and look incomplete.

## 4. Compare Requested Vs Effective Timeframe

Do not assume the requested timeframe is what came back.

Example:

```text
requested timeframe: 1min
effective timeframe: 30min
```

If `x-effective-timeframe` differs from the requested resolution, the chart must treat the bars as the effective resolution.

## 5. Check Chain Normalization

Confirm whether the external client sends:

```text
chain=base
```

or:

```text
chain=0x2105
```

Different chain strings can create separate cache namespaces unless normalized. If local reference uses `base` and external uses `0x2105`, the two charts may hit different cache entries.

## 6. Confirm Pair Address

Make sure the external chart sends the pair address, not the token address.

For VibeCaps SYMM reference, verify the actual pair address matches:

```text
0x3eB2a8015dE1419a5089dAb37b0056F0fc24f821
```

Wrong pair address means a valid but different chart.

## 7. Inspect Returned Candles

For one response, log:

```text
result.length
first timestamp
last timestamp
first OHLC
last OHLC
cursor
```

If `result.length` is low, that may be normal sparse Moralis data or a cache/rate-limit protection result.

## 8. Disable Visual Transform Assumptions Temporarily

The external chart currently rewrites candle opens:

```ts
open = previous.close
```

For debugging, compare once with raw upstream opens. This can be a major visual difference from our local reference.

Also confirm whether volume rendering is enabled, because the reference chart includes volume.

## 9. Watch For 429s

If the external frontend sends many chunk requests quickly, our cache returns `429` for protection.

A `429` request does not spend Moralis CU, but it can make the external chart incomplete if not handled gracefully.

Look for repeated requests like:

```text
timeframe=1min
limit=130
older and older fromDate/toDate windows
```

That means their chart loader is chunking aggressively instead of using our cursor/page model.

## Recommended First Debug Probe

Use one bounded request:

```text
GET {CLOUDFLARE_URL}/api/v2.2/pairs/{PAIR}/ohlcv?chain=base&timeframe=1h&currency=usd&fromDate=2026-04-30T00:00:00.000Z&toDate=2026-04-30T02:00:00.000Z&limit=10
X-API-Key: <key>
```

Record:

```text
status
headers
result count
cursor
first timestamp
last timestamp
```

Only after this single request is understood should we debug wide ranges or chart rendering.

## Likely Root Causes

Most likely issues, in order:

1. External proxy ignores `cursor`.
2. External chart ignores `x-effective-timeframe`.
3. Chain mismatch: `base` vs `0x2105`.
4. Pair address mismatch.
5. Previous-close-open rewriting changes visual shape.
6. Sparse Moralis data is rendered without gap-fill awareness.
7. External loader triggers 429s by requesting too many historical chunks too quickly.
