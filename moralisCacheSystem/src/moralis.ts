import { config } from './config.js';
import { appendInteractionTraceEvent } from './interactionLog.js';
import { moralisLogger } from './logger.js';
import { providerUsageRepository } from './repositories/providerUsage.js';
import { redis } from './redis.js';
import type { MoralisCandle, OhlcvCurrency, OhlcvTimeframe } from './types.js';

const MORALIS_OHLC_CU_COST = 150;

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
  if (!config.CHART_PROVIDER_ENABLED) {
    return false;
  }

  const flag = await redis.get('feature:moralis_ohlcv_enabled');
  return flag !== 'false';
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

  if (usedToday + extraCu > config.MORALIS_DAILY_CU_BUDGET) {
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

  const maxPages = params.maxPages ?? config.MAX_SYNC_MORALIS_PAGES;
  await assertDailyMoralisBudgetAvailable(maxPages * MORALIS_OHLC_CU_COST);

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
      maxPages,
      estimatedMaxCu: maxPages * MORALIS_OHLC_CU_COST,
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
    maxPages,
    estimatedMaxCu: maxPages * MORALIS_OHLC_CU_COST,
  });

  do {
    if (pages >= maxPages) {
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
    url.searchParams.set('limit', '1000');

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

function buildMoralisOhlcvUrl(chain: string, pairAddress: string) {
  if (chain === 'solana') {
    return new URL(`https://solana-gateway.moralis.io/token/mainnet/pairs/${pairAddress}/ohlcv`);
  }

  return new URL(`https://deep-index.moralis.io/api/v2.2/pairs/${pairAddress}/ohlcv`);
}
