# Moralis OHLC Cache - Moralis Provider Adapter

## Purpose

The Moralis provider adapter is the only code allowed to call Moralis OHLC endpoints. It lives on the backend, adds the API key server-side, handles pagination, logs usage, and enforces strict page limits.

Frontend code must never import or call this adapter.

## Moralis Endpoint

EVM OHLC endpoint:

```text
GET https://deep-index.moralis.io/api/v2.2/pairs/{pairAddress}/ohlcv
```

Common query parameters:

```text
chain=eth
timeframe=1min
currency=usd
fromDate=2026-04-27T00:00:00.000Z
toDate=2026-04-28T00:00:00.000Z
limit=1000
cursor=...
```

Billing:

```text
getPairCandlesticks / OHLCV = 150 CUs per API call
```

If a range requires 10 pages, it costs roughly:

```text
10 pages * 150 CUs = 1500 CUs
```

## Provider Types

```ts
export type OhlcvTimeframe =
  | '1s'
  | '10s'
  | '30s'
  | '1min'
  | '5min'
  | '10min'
  | '30min'
  | '1h'
  | '4h'
  | '12h'
  | '1d'
  | '1w'
  | '1M';

export type OhlcvCurrency = 'usd' | 'native';

export type MoralisCandle = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  trades?: number;
};

export type MoralisOhlcvResponse = {
  cursor?: string | null;
  page?: number | string;
  pairAddress?: string;
  tokenAddress?: string;
  timeframe?: string;
  currency?: string;
  result?: MoralisCandle[];
};
```

## Fetcher With Pagination Guard

```ts
const MORALIS_OHLC_CU_COST = 150;

export async function fetchMoralisOhlcv(params: {
  apiKey: string;
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  fromDate: Date;
  toDate: Date;
  maxPages?: number;
  signal?: AbortSignal;
}): Promise<{ candles: MoralisCandle[]; pages: number; estimatedCu: number }> {
  const candles: MoralisCandle[] = [];
  let cursor: string | undefined;
  let pages = 0;
  const maxPages = params.maxPages ?? 3;

  do {
    if (pages >= maxPages) {
      break;
    }

    const url = new URL(
      `https://deep-index.moralis.io/api/v2.2/pairs/${params.pairAddress}/ohlcv`
    );

    url.searchParams.set('chain', params.chain);
    url.searchParams.set('timeframe', params.timeframe);
    url.searchParams.set('currency', params.currency);
    url.searchParams.set('fromDate', params.fromDate.toISOString());
    url.searchParams.set('toDate', params.toDate.toISOString());
    url.searchParams.set('limit', '1000');

    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }

    const startedAt = Date.now();
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'X-API-Key': params.apiKey,
      },
      signal: params.signal,
    });

    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      const body = await response.text();
      throw new MoralisProviderError({
        status: response.status,
        body,
        durationMs,
      });
    }

    const json = (await response.json()) as MoralisOhlcvResponse;
    candles.push(...(json.result ?? []));
    cursor = json.cursor ?? undefined;
    pages += 1;
  } while (cursor);

  return {
    candles,
    pages,
    estimatedCu: pages * MORALIS_OHLC_CU_COST,
  };
}
```

## Provider Error

```ts
export class MoralisProviderError extends Error {
  status: number;
  durationMs: number;

  constructor(params: {
    status: number;
    body: string;
    durationMs: number;
  }) {
    super(`Moralis OHLCV failed with status ${params.status}`);
    this.status = params.status;
    this.durationMs = params.durationMs;
  }
}
```

Do not include request headers or API keys in thrown errors or logs.

## Fetch and Store Gap

```ts
export async function fetchAndStoreGap(params: {
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  from: Date;
  to: Date;
  maxPages: number;
}) {
  await assertMoralisOhlcvEnabled();

  const lockKey = [
    'ohlcv',
    'fetch',
    params.chain,
    params.pairAddress.toLowerCase(),
    params.timeframe,
    params.currency,
    params.from.toISOString(),
    params.to.toISOString(),
  ].join(':');

  return withRedisLock(lockKey, 30_000, async () => {
    const startedAt = Date.now();

    const result = await fetchMoralisOhlcv({
      apiKey: process.env.MORALIS_API_KEY!,
      chain: params.chain,
      pairAddress: params.pairAddress,
      timeframe: params.timeframe,
      currency: params.currency,
      fromDate: params.from,
      toDate: params.to,
      maxPages: params.maxPages,
    });

    await candleRepository.upsertCandles({
      chain: params.chain,
      pairAddress: params.pairAddress.toLowerCase(),
      timeframe: params.timeframe,
      currency: params.currency,
      candles: result.candles,
    });

    await providerUsageRepository.log({
      provider: 'moralis',
      endpoint: 'getPairCandlesticks',
      chain: params.chain,
      pairAddress: params.pairAddress.toLowerCase(),
      timeframe: params.timeframe,
      requestFrom: params.from,
      requestTo: params.to,
      httpStatus: 200,
      estimatedCu: result.estimatedCu,
      pages: result.pages,
      durationMs: Date.now() - startedAt,
    });

    return result;
  });
}
```

## CU Budget Guard

Provider calls should stop automatically when the daily budget is reached.

```ts
export async function assertDailyMoralisBudgetAvailable(extraCu: number) {
  const usedToday = await providerUsageRepository.sumEstimatedCu({
    provider: 'moralis',
    from: startOfDay(new Date()),
    to: new Date(),
  });

  const dailyBudget = Number(process.env.MORALIS_DAILY_CU_BUDGET ?? 5_000_000);

  if (usedToday + extraCu > dailyBudget) {
    throw new Error('Moralis daily CU budget exceeded');
  }
}
```

Call it before known provider work:

```ts
await assertDailyMoralisBudgetAvailable(maxPages * MORALIS_OHLC_CU_COST);
```

## Circuit Breaker

```ts
export async function isMoralisOhlcvEnabled() {
  const flag = await redis.get('feature:moralis_ohlcv_enabled');
  return flag !== 'false';
}

export async function assertMoralisOhlcvEnabled() {
  if (!(await isMoralisOhlcvEnabled())) {
    throw new Error('Moralis OHLC provider is disabled');
  }
}
```

## Retry Policy

Recommended:

- Retry `429`, `500`, `502`, `503`, `504`.
- Do not retry `400`, `401`, `403`, `404`.
- Use exponential backoff.
- Keep retry count low for synchronous user requests.
- Workers can retry more aggressively, but must respect CU budget.

Example:

```ts
export async function withProviderRetry<T>(fn: () => Promise<T>) {
  const delays = [250, 1000, 3000];

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryableProviderError(error) || attempt === delays.length) {
        throw error;
      }

      await sleep(delays[attempt]);
    }
  }

  throw new Error('Unexpected retry state');
}

function isRetryableProviderError(error: unknown) {
  if (!(error instanceof MoralisProviderError)) {
    return false;
  }

  return [429, 500, 502, 503, 504].includes(error.status);
}
```

## Endpoint Weights Verification

Moralis exposes endpoint weights so the team can verify live CU pricing.

Use periodically in an internal script:

```text
GET /info/endpointWeights
```

Record the current `getPairCandlesticks` cost in logs or an admin page. Do not hard-depend on the docs if Moralis changes pricing.

## Provider Acceptance Criteria

- Provider adapter is backend-only.
- API key is never sent to the browser.
- All provider calls have `maxPages`.
- All provider calls are logged with estimated CU usage.
- Moralis can be disabled instantly with a feature flag.
- Daily CU budget can stop new provider work.
- Provider errors do not leak secrets.
