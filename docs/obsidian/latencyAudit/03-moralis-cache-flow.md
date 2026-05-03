# 03 — Cache, Gaps, Locks, and Moralis Flow

Relevant files:

- `moralisCacheSystem/src/services/chartService.ts`
- `moralisCacheSystem/src/repositories/candles.ts`
- `moralisCacheSystem/src/gaps.ts`
- `moralisCacheSystem/src/locks.ts`
- `moralisCacheSystem/src/moralis.ts`
- `moralisCacheSystem/src/cache.ts`

## 1. Redis chart response cache

Cache key is built in `cache.ts`:

```ts
chart:ohlcv:v3:<chain>:<pairAddress>:<timeframe>:<currency>:<from>:<to>
```

Current TTLs:

```txt
1min:       15s
5/10min:   30s
30min/1h:  60s
default:    300s
```

For `4h`, TTL is `300s`.

Important: the key includes exact `from` and `to` timestamps. If the frontend sends a slightly different `to` every reload, the response cache misses.

For live charts, this means Redis response cache may be less useful than expected unless `to` is aligned/stabilized.

## 2. Candle DB lookup

If the response cache misses, backend queries Postgres:

```sql
SELECT timestamp, open, high, low, close, volume, trades
FROM ohlcv_candles
WHERE chain = $1
  AND pair_address = $2
  AND timeframe = $3
  AND currency = $4
  AND timestamp >= $5
  AND timestamp <= $6
ORDER BY timestamp ASC
```

This should be fast locally if indexes are correct.

The perceived slowness is more likely before/after this query, not the query itself.

## 3. Missing range detection

`findMissingRanges()` loops every candle bucket between `from` and `to`.

For `4h` over 7 days:

```txt
7 * 24 / 4 = 42 buckets
```

Fast.

For `4h` from 2024-01-01 to now:

```txt
~5000 buckets
```

Still not huge, but unnecessary for a 7-day visible chart.

## 4. Provider fetch decision

If missing ranges exist:

1. `cache_gaps_detected` trace event is logged.
2. Provider miss rate-limit is enforced.
3. Gaps are prioritized by visibility.
4. Backend fetches at most `maxProviderFetches`, currently `1`.

## 5. Redis gap lock

Before Moralis call:

```ts
withRedisLock(lockKey, 30_000, async () => { ... })
```

If another request is already fetching the exact same gap:

```ts
if (!acquired) return undefined;
```

Then the backend marks the response partial.

There is no wait/retry loop here. A lock collision returns immediately, which can make the frontend try again later.

## 6. Moralis call

`fetchMoralisOhlcv()` checks:

1. provider enabled flag in Redis
2. API key present
3. daily CU budget
4. calls `fetchMoralisPages()`

For Solana:

```txt
https://solana-gateway.moralis.io/token/mainnet/pairs/<pairAddress>/ohlcv
```

For Solana `1d`, we now avoid Moralis broken daily candles by fetching `1h` and aggregating to daily.

For Solana empty responses, we now try Dexscreener `pairCreatedAt` and retry from the pair creation day.

## 7. Upsert candles

Previously, candle upsert was one SQL statement per candle inside a transaction.

This has been changed to batched upsert chunks of 500 candles.

This should materially improve performance for larger responses.

## 8. Final response

After provider fetch, backend queries DB again and builds response:

```ts
candles: fillMissingChartCandles(...)
```

Then it writes the full chart response to Redis only if:

```ts
!response.partial
```

Partial responses are intentionally not cached.

## Key latency implication

Even if local DB lookup is milliseconds, a frontend-expanded request can force backend to do old-history gap analysis and possibly old-history Moralis/Dexscreener logic before visible candles are returned.
