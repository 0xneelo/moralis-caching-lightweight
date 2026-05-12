import { getAdminSettings } from './adminConfig.js';
import { config } from './config.js';
import { appendInteractionTraceEvent } from './interactionLog.js';
import { moralisLogger } from './logger.js';
import { logMissingMoralisDailyCandles } from './missingCandlesMoralis.js';
import { providerUsageRepository } from './repositories/providerUsage.js';
import { redis } from './redis.js';
import { alignToCandleStart } from './timeframes.js';
import type { MoralisCandle, OhlcvCurrency, OhlcvTimeframe } from './types.js';

const MORALIS_OHLC_CU_COST = 150;
const MORALIS_OHLC_LIMIT_PER_PAGE = 1000;

type MoralisOhlcvResponse = {
  cursor?: string | null;
  result?: MoralisCandle[];
};

export class MoralisProviderError extends Error {
  status: number;
  durationMs: number;

  constructor(params: { status: number; durationMs: number }) {
    super(`Moralis OHLCV failed with status ${params.status}`);
    this.status = params.status;
    this.durationMs = params.durationMs;
  }
}

export async function isMoralisOhlcvEnabled() {
  const flag = await redis.get('feature:moralis_ohlcv_enabled');
  if (flag === 'false') return false;
  if (flag === 'true') return true;

  return (await getAdminSettings()).moralisOhlcvEnabled;
}

export async function assertMoralisOhlcvEnabled() {
  if (!(await isMoralisOhlcvEnabled())) {
    throw new Error('Moralis OHLC provider is disabled');
  }
}

export async function assertDailyMoralisBudgetAvailable(extraCu: number) {
  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const usedToday = await providerUsageRepository.sumEstimatedCu({
    provider: 'moralis',
    from: startOfDay,
    to: now,
  });

  const settings = await getAdminSettings();

  if (usedToday + extraCu > settings.moralisDailyCuBudget) {
    throw new Error('Moralis daily CU budget exceeded');
  }
}

export async function fetchMoralisOhlcv(params: {
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  fromDate: Date;
  toDate: Date;
  maxPages?: number;
  signal?: AbortSignal;
  interactionId?: string | undefined;
}) {
  await assertMoralisOhlcvEnabled();

  if (!config.MORALIS_API_KEY) {
    throw new Error('MORALIS_API_KEY is required to call Moralis');
  }

  const settings = await getAdminSettings();
  const maxPages = params.maxPages ?? settings.maxSyncMoralisPages;
  await assertDailyMoralisBudgetAvailable(maxPages * MORALIS_OHLC_CU_COST);

  const result = params.chain === 'solana' && shouldAggregateSolanaTimeframe(params.timeframe)
    ? await fetchSolanaOhlcvAggregatedFromFiveMinute({
        ...params,
        maxPages,
      })
    : params.chain === 'solana'
      ? await fetchSolanaPagesWithCreatedAtRetry({
          ...params,
          maxPages,
        })
      : await fetchMoralisPages({
          ...params,
          maxPages,
        });

  if (params.timeframe === '1d' && result.candles.length === 0) {
    await logMissingMoralisDailyCandles({
      chain: params.chain,
      pairAddress: params.pairAddress,
      currency: params.currency,
      fromDate: params.fromDate,
      toDate: params.toDate,
      pages: result.pages,
      estimatedCu: result.estimatedCu,
      truncated: result.truncated,
      interactionId: params.interactionId,
    });
  }

  return result;
}

async function fetchMoralisPages(params: {
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  fromDate: Date;
  toDate: Date;
  maxPages: number;
  signal?: AbortSignal;
  interactionId?: string | undefined;
}) {
  const candles: MoralisCandle[] = [];
  let cursor: string | undefined;
  let pages = 0;
  const startedAt = Date.now();

  moralisLogger.warn(
    {
      provider: 'moralis',
      event: 'MORALIS_OHLCV_START',
      chain: params.chain,
      pairAddress: params.pairAddress,
      timeframe: params.timeframe,
      currency: params.currency,
      from: params.fromDate.toISOString(),
      to: params.toDate.toISOString(),
      maxPages: params.maxPages,
      estimatedMaxCu: params.maxPages * MORALIS_OHLC_CU_COST,
    },
    'MORALIS_OHLCV_START'
  );
  await appendInteractionTraceEvent(params.interactionId, 'moralis_start', {
    chain: params.chain,
    pairAddress: params.pairAddress,
    timeframe: params.timeframe,
    currency: params.currency,
    from: params.fromDate.toISOString(),
    to: params.toDate.toISOString(),
    maxPages: params.maxPages,
    estimatedMaxCu: params.maxPages * MORALIS_OHLC_CU_COST,
  });

  do {
    if (pages >= params.maxPages) {
      break;
    }

    const url = buildMoralisOhlcvUrl(params.chain, params.pairAddress);

    if (params.chain !== 'solana') {
      url.searchParams.set('chain', params.chain);
    }
    url.searchParams.set('timeframe', params.timeframe);
    url.searchParams.set('currency', params.currency);
    url.searchParams.set('fromDate', params.fromDate.toISOString());
    url.searchParams.set('toDate', params.toDate.toISOString());
    url.searchParams.set('limit', String(MORALIS_OHLC_LIMIT_PER_PAGE));

    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }

    const pageStartedAt = Date.now();
    const requestInit: RequestInit = {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'X-API-Key': config.MORALIS_API_KEY,
      },
    };

    if (params.signal) {
      requestInit.signal = params.signal;
    }

    const response = await fetch(url, requestInit);

    if (!response.ok) {
      moralisLogger.error(
        {
          provider: 'moralis',
          event: 'MORALIS_OHLCV_PAGE_FAILED',
          chain: params.chain,
          pairAddress: params.pairAddress,
          timeframe: params.timeframe,
          currency: params.currency,
          from: params.fromDate.toISOString(),
          to: params.toDate.toISOString(),
          page: pages + 1,
          status: response.status,
          durationMs: Date.now() - pageStartedAt,
        },
        'MORALIS_OHLCV_PAGE_FAILED'
      );
      await appendInteractionTraceEvent(params.interactionId, 'moralis_page_failed', {
        chain: params.chain,
        pairAddress: params.pairAddress,
        timeframe: params.timeframe,
        currency: params.currency,
        from: params.fromDate.toISOString(),
        to: params.toDate.toISOString(),
        page: pages + 1,
        status: response.status,
        durationMs: Date.now() - pageStartedAt,
      });
      throw new MoralisProviderError({
        status: response.status,
        durationMs: Date.now() - pageStartedAt,
      });
    }

    const json = (await response.json()) as MoralisOhlcvResponse;
    const pageCandles = json.result ?? [];
    candles.push(...pageCandles);
    cursor = json.cursor ?? undefined;
    pages += 1;

    moralisLogger.warn(
      {
        provider: 'moralis',
        event: 'MORALIS_OHLCV_PAGE_OK',
        chain: params.chain,
        pairAddress: params.pairAddress,
        timeframe: params.timeframe,
        currency: params.currency,
        from: params.fromDate.toISOString(),
        to: params.toDate.toISOString(),
        page: pages,
        pageCandles: pageCandles.length,
        hasNextCursor: Boolean(cursor),
        estimatedCuSoFar: pages * MORALIS_OHLC_CU_COST,
        durationMs: Date.now() - pageStartedAt,
      },
      'MORALIS_OHLCV_PAGE_OK'
    );
    await appendInteractionTraceEvent(params.interactionId, 'moralis_page_ok', {
      chain: params.chain,
      pairAddress: params.pairAddress,
      timeframe: params.timeframe,
      currency: params.currency,
      from: params.fromDate.toISOString(),
      to: params.toDate.toISOString(),
      page: pages,
      pageCandles: pageCandles.length,
      hasNextCursor: Boolean(cursor),
      estimatedCuSoFar: pages * MORALIS_OHLC_CU_COST,
      durationMs: Date.now() - pageStartedAt,
    });
  } while (cursor);

  moralisLogger.warn(
    {
      provider: 'moralis',
      event: 'MORALIS_OHLCV_DONE',
      chain: params.chain,
      pairAddress: params.pairAddress,
      timeframe: params.timeframe,
      currency: params.currency,
      from: params.fromDate.toISOString(),
      to: params.toDate.toISOString(),
      pages,
      candles: candles.length,
      estimatedCu: pages * MORALIS_OHLC_CU_COST,
      durationMs: Date.now() - startedAt,
      truncated: Boolean(cursor),
    },
    'MORALIS_OHLCV_DONE'
  );
  await appendInteractionTraceEvent(params.interactionId, 'moralis_done', {
    chain: params.chain,
    pairAddress: params.pairAddress,
    timeframe: params.timeframe,
    currency: params.currency,
    from: params.fromDate.toISOString(),
    to: params.toDate.toISOString(),
    pages,
    candles: candles.length,
    estimatedCu: pages * MORALIS_OHLC_CU_COST,
    durationMs: Date.now() - startedAt,
    truncated: Boolean(cursor),
  });

  return {
    candles,
    pages,
    estimatedCu: pages * MORALIS_OHLC_CU_COST,
    durationMs: Date.now() - startedAt,
    truncated: Boolean(cursor),
  };
}

function shouldAggregateSolanaTimeframe(timeframe: OhlcvTimeframe) {
  return ['1h', '4h', '6h', '12h', '1d'].includes(timeframe);
}

async function fetchSolanaOhlcvAggregatedFromFiveMinute(params: {
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  fromDate: Date;
  toDate: Date;
  maxPages: number;
  signal?: AbortSignal;
  interactionId?: string | undefined;
}) {
  await appendInteractionTraceEvent(params.interactionId, 'moralis_solana_aggregate_from_5min', {
    chain: params.chain,
    pairAddress: params.pairAddress,
    requestedTimeframe: params.timeframe,
    fetchTimeframe: '5min',
    currency: params.currency,
    from: params.fromDate.toISOString(),
    to: params.toDate.toISOString(),
  });

  const fiveMinuteResult = await fetchSolanaPagesWithCreatedAtRetry({
    ...params,
    timeframe: '5min',
  });

  return {
    ...fiveMinuteResult,
    candles: aggregateCandlesToTimeframe(fiveMinuteResult.candles, params.timeframe),
  };
}

async function fetchSolanaPagesWithCreatedAtRetry(params: {
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  fromDate: Date;
  toDate: Date;
  maxPages: number;
  signal?: AbortSignal;
  interactionId?: string | undefined;
}) {
  const initialResult = await fetchMoralisPages(params);

  if (initialResult.candles.length > 0) {
    return initialResult;
  }

  const pairCreatedAt = await fetchDexscreenerPairCreatedAt(params.pairAddress);

  if (!pairCreatedAt || pairCreatedAt <= params.fromDate || pairCreatedAt >= params.toDate) {
    return initialResult;
  }

  const retryFromDate = alignDateDownToUtcDay(pairCreatedAt);
  await appendInteractionTraceEvent(params.interactionId, 'moralis_solana_retry_from_pair_created_at', {
    chain: params.chain,
    pairAddress: params.pairAddress,
    timeframe: params.timeframe,
    currency: params.currency,
    originalFrom: params.fromDate.toISOString(),
    retryFrom: retryFromDate.toISOString(),
    to: params.toDate.toISOString(),
  });

  const retryResult = await fetchMoralisPages({
    ...params,
    fromDate: retryFromDate,
  });

  return {
    ...retryResult,
    pages: initialResult.pages + retryResult.pages,
    estimatedCu: initialResult.estimatedCu + retryResult.estimatedCu,
    durationMs: initialResult.durationMs + retryResult.durationMs,
    truncated: initialResult.truncated || retryResult.truncated,
  };
}

async function fetchDexscreenerPairCreatedAt(pairAddress: string) {
  try {
    const url = new URL(`https://api.dexscreener.com/latest/dex/pairs/solana/${pairAddress}`);
    const startedAt = Date.now();
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
    });

    if (!response.ok) {
      return null;
    }

    const json = (await response.json()) as { pair?: { pairCreatedAt?: number | string | null } | null };
    const pairCreatedAtMs = Number(json.pair?.pairCreatedAt);

    moralisLogger.warn(
      {
        provider: 'dexscreener',
        event: 'DEXSCREENER_PAIR_CREATED_AT_OK',
        pairAddress,
        pairCreatedAtMs: Number.isFinite(pairCreatedAtMs) ? pairCreatedAtMs : null,
        durationMs: Date.now() - startedAt,
      },
      'DEXSCREENER_PAIR_CREATED_AT_OK'
    );

    if (!Number.isFinite(pairCreatedAtMs) || pairCreatedAtMs <= 0) {
      return null;
    }

    return new Date(pairCreatedAtMs);
  } catch {
    return null;
  }
}

function alignDateDownToUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function aggregateCandlesToTimeframe(candles: MoralisCandle[], timeframe: OhlcvTimeframe): MoralisCandle[] {
  const sorted = [...candles]
    .filter((candle) => Number.isFinite(new Date(candle.timestamp).getTime()))
    .sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());
  const byBucket = new Map<string, MoralisCandle[]>();

  for (const candle of sorted) {
    const bucket = alignToCandleStart(new Date(candle.timestamp), timeframe).toISOString();
    const bucketCandles = byBucket.get(bucket) ?? [];
    bucketCandles.push(candle);
    byBucket.set(bucket, bucketCandles);
  }

  return [...byBucket.entries()].map(([timestamp, bucketCandles]) => {
    const first = bucketCandles[0]!;
    const last = bucketCandles[bucketCandles.length - 1]!;
    const prices = bucketCandles.flatMap((candle) => [
      Number(candle.open),
      Number(candle.high),
      Number(candle.low),
      Number(candle.close),
    ]).filter(Number.isFinite);
    const volume = bucketCandles.reduce((sum, candle) => sum + (Number(candle.volume) || 0), 0);
    const trades = bucketCandles.reduce((sum, candle) => sum + (Number(candle.trades) || 0), 0);

    return {
      timestamp,
      open: Number(first.open),
      high: Math.max(...prices),
      low: Math.min(...prices),
      close: Number(last.close),
      volume,
      trades,
    };
  });
}

function buildMoralisOhlcvUrl(chain: string, pairAddress: string) {
  if (chain === 'solana') {
    return new URL(`https://solana-gateway.moralis.io/token/mainnet/pairs/${pairAddress}/ohlcv`);
  }

  return new URL(`https://deep-index.moralis.io/api/v2.2/pairs/${pairAddress}/ohlcv`);
}
