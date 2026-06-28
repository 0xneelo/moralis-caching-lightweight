import { config } from '../../config.js';
import { appendInteractionTraceEvent } from '../../interactionLog.js';
import { logger } from '../../logger.js';
import { providerUsageRepository } from '../../repositories/providerUsage.js';
import { alignToCandleStart } from '../../timeframes.js';
import type { MoralisCandle, OhlcvTimeframe } from '../../types.js';
import type { FetchOhlcvParams, FetchOhlcvResult, OhlcvProvider } from './types.js';

const COINGECKO_OHLC_LIMIT_PER_PAGE = 1000;
const ONE_CREDIT_PER_PAGE = 1;

type CoinGeckoOhlcvTimeframe = 'second' | 'minute' | 'hour' | 'day';

type CoinGeckoOhlcvResponse = {
  data?: {
    attributes?: {
      ohlcv_list?: unknown[];
    };
  };
};

type CoinGeckoTimeframePlan = {
  timeframe: CoinGeckoOhlcvTimeframe;
  aggregate: number;
  localAggregateTo?: OhlcvTimeframe;
};

export class CoinGeckoProviderError extends Error {
  status: number;
  durationMs: number;

  constructor(params: { status: number; durationMs: number }) {
    super(`CoinGecko OHLCV failed with status ${params.status}`);
    this.status = params.status;
    this.durationMs = params.durationMs;
  }
}

export const coingeckoOhlcvProvider: OhlcvProvider = {
  id: 'coingecko',
  endpoint: 'poolOhlcv',
  fetchOhlcv: fetchCoinGeckoOhlcv,
};

export async function fetchCoinGeckoOhlcv(params: FetchOhlcvParams): Promise<FetchOhlcvResult> {
  assertCoinGeckoOhlcvEnabled();

  if (!config.COINGECKO_API_KEY) {
    throw new Error('COINGECKO_API_KEY is required to call CoinGecko');
  }

  if (params.currency !== 'usd') {
    throw new Error('CoinGecko OHLCV provider currently supports usd currency only');
  }

  const plan = getCoinGeckoTimeframePlan(params.timeframe);
  const network = toCoinGeckoNetwork(params.chain);
  const maxPages = params.maxPages ?? config.COINGECKO_MAX_SYNC_PAGES;
  await assertDailyCoinGeckoBudgetAvailable(maxPages * ONE_CREDIT_PER_PAGE);

  const startedAt = Date.now();
  const sourceCandles = new Map<number, MoralisCandle>();
  const fromSeconds = Math.floor(params.fromDate.getTime() / 1000);
  const toSeconds = Math.floor(params.toDate.getTime() / 1000);
  let beforeTimestamp = toSeconds + 1;
  let pages = 0;
  let oldestFetchedSeconds: number | null = null;
  let hitEmptyPage = false;

  logger.warn(
    {
      provider: 'coingecko',
      event: 'COINGECKO_OHLCV_START',
      network,
      chain: params.chain,
      pairAddress: params.pairAddress,
      timeframe: params.timeframe,
      coingeckoTimeframe: plan.timeframe,
      aggregate: plan.aggregate,
      currency: params.currency,
      from: params.fromDate.toISOString(),
      to: params.toDate.toISOString(),
      maxPages,
    },
    'COINGECKO_OHLCV_START'
  );
  await appendInteractionTraceEvent(params.interactionId, 'coingecko_start', {
    chain: params.chain,
    network,
    pairAddress: params.pairAddress,
    timeframe: params.timeframe,
    coingeckoTimeframe: plan.timeframe,
    aggregate: plan.aggregate,
    currency: params.currency,
    from: params.fromDate.toISOString(),
    to: params.toDate.toISOString(),
    maxPages,
  });

  while (pages < maxPages) {
    const url = buildCoinGeckoOhlcvUrl({
      network,
      pairAddress: params.pairAddress,
      timeframe: plan.timeframe,
      aggregate: plan.aggregate,
      beforeTimestamp,
      currency: params.currency,
    });
    const pageStartedAt = Date.now();
    const requestInit: RequestInit = {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-cg-pro-api-key': config.COINGECKO_API_KEY,
      },
    };

    if (params.signal) {
      requestInit.signal = params.signal;
    }

    const response = await fetch(url, requestInit);

    if (!response.ok) {
      logger.error(
        {
          provider: 'coingecko',
          event: 'COINGECKO_OHLCV_PAGE_FAILED',
          network,
          chain: params.chain,
          pairAddress: params.pairAddress,
          timeframe: params.timeframe,
          page: pages + 1,
          status: response.status,
          durationMs: Date.now() - pageStartedAt,
        },
        'COINGECKO_OHLCV_PAGE_FAILED'
      );
      await appendInteractionTraceEvent(params.interactionId, 'coingecko_page_failed', {
        chain: params.chain,
        network,
        pairAddress: params.pairAddress,
        timeframe: params.timeframe,
        page: pages + 1,
        status: response.status,
        durationMs: Date.now() - pageStartedAt,
      });
      throw new CoinGeckoProviderError({
        status: response.status,
        durationMs: Date.now() - pageStartedAt,
      });
    }

    const json = (await response.json()) as CoinGeckoOhlcvResponse;
    const pageCandles = parseCoinGeckoCandles(json.data?.attributes?.ohlcv_list ?? []);
    pages += 1;

    if (pageCandles.length === 0) {
      hitEmptyPage = true;
      break;
    }

    for (const candle of pageCandles) {
      const timestampSeconds = Math.floor(new Date(candle.timestamp).getTime() / 1000);
      if (timestampSeconds <= toSeconds) {
        sourceCandles.set(timestampSeconds, candle);
      }
    }

    const pageOldestSeconds = Math.min(...pageCandles.map((candle) => Math.floor(new Date(candle.timestamp).getTime() / 1000)));
    oldestFetchedSeconds = oldestFetchedSeconds === null ? pageOldestSeconds : Math.min(oldestFetchedSeconds, pageOldestSeconds);

    logger.warn(
      {
        provider: 'coingecko',
        event: 'COINGECKO_OHLCV_PAGE_OK',
        network,
        chain: params.chain,
        pairAddress: params.pairAddress,
        timeframe: params.timeframe,
        page: pages,
        pageCandles: pageCandles.length,
        estimatedCreditsSoFar: pages * ONE_CREDIT_PER_PAGE,
        durationMs: Date.now() - pageStartedAt,
      },
      'COINGECKO_OHLCV_PAGE_OK'
    );
    await appendInteractionTraceEvent(params.interactionId, 'coingecko_page_ok', {
      chain: params.chain,
      network,
      pairAddress: params.pairAddress,
      timeframe: params.timeframe,
      page: pages,
      pageCandles: pageCandles.length,
      estimatedCreditsSoFar: pages * ONE_CREDIT_PER_PAGE,
      durationMs: Date.now() - pageStartedAt,
    });

    if (pageOldestSeconds <= fromSeconds) {
      break;
    }

    beforeTimestamp = pageOldestSeconds - 1;
  }

  const fetchedCandles = [...sourceCandles.values()].sort(
    (left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()
  );
  const normalizedCandles = plan.localAggregateTo
    ? aggregateCandlesToTimeframe(fetchedCandles, plan.localAggregateTo)
    : fetchedCandles;
  const candles = normalizedCandles.filter((candle) => {
    const timestampSeconds = Math.floor(new Date(candle.timestamp).getTime() / 1000);
    return timestampSeconds >= fromSeconds && timestampSeconds <= toSeconds;
  });
  const truncated = !hitEmptyPage && pages >= maxPages && (oldestFetchedSeconds === null || oldestFetchedSeconds > fromSeconds);

  logger.warn(
    {
      provider: 'coingecko',
      event: 'COINGECKO_OHLCV_DONE',
      network,
      chain: params.chain,
      pairAddress: params.pairAddress,
      timeframe: params.timeframe,
      pages,
      candles: candles.length,
      estimatedCu: pages * ONE_CREDIT_PER_PAGE,
      durationMs: Date.now() - startedAt,
      truncated,
    },
    'COINGECKO_OHLCV_DONE'
  );
  await appendInteractionTraceEvent(params.interactionId, 'coingecko_done', {
    chain: params.chain,
    network,
    pairAddress: params.pairAddress,
    timeframe: params.timeframe,
    pages,
    candles: candles.length,
    estimatedCu: pages * ONE_CREDIT_PER_PAGE,
    durationMs: Date.now() - startedAt,
    truncated,
  });

  return {
    candles,
    pages,
    estimatedCu: pages * ONE_CREDIT_PER_PAGE,
    durationMs: Date.now() - startedAt,
    truncated,
  };
}

function assertCoinGeckoOhlcvEnabled() {
  if (!config.COINGECKO_OHLCV_ENABLED) {
    throw new Error('CoinGecko OHLC provider is disabled');
  }
}

async function assertDailyCoinGeckoBudgetAvailable(extraCredits: number) {
  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const usedToday = await providerUsageRepository.sumEstimatedCu({
    provider: 'coingecko',
    from: startOfDay,
    to: now,
  });

  if (usedToday + extraCredits > config.COINGECKO_DAILY_CREDIT_BUDGET) {
    throw new Error('CoinGecko daily credit budget exceeded');
  }
}

function buildCoinGeckoOhlcvUrl(params: {
  network: string;
  pairAddress: string;
  timeframe: CoinGeckoOhlcvTimeframe;
  aggregate: number;
  beforeTimestamp: number;
  currency: 'usd';
}) {
  const baseUrl = config.COINGECKO_API_BASE_URL.replace(/\/+$/, '');
  const url = new URL(`${baseUrl}/onchain/networks/${params.network}/pools/${params.pairAddress}/ohlcv/${params.timeframe}`);
  url.searchParams.set('aggregate', String(params.aggregate));
  url.searchParams.set('before_timestamp', String(params.beforeTimestamp));
  url.searchParams.set('limit', String(COINGECKO_OHLC_LIMIT_PER_PAGE));
  url.searchParams.set('currency', params.currency);
  url.searchParams.set('include_empty_intervals', 'false');
  return url;
}

function parseCoinGeckoCandles(items: unknown[]): MoralisCandle[] {
  const candles: MoralisCandle[] = [];

  for (const item of items) {
    if (!Array.isArray(item) || item.length < 6) {
      continue;
    }

    const timestamp = Number(item[0]);
    const open = Number(item[1]);
    const high = Number(item[2]);
    const low = Number(item[3]);
    const close = Number(item[4]);
    const volume = Number(item[5]);

    if (![timestamp, open, high, low, close, volume].every(Number.isFinite)) {
      continue;
    }

    candles.push({
      timestamp: new Date(timestamp * 1000).toISOString(),
      open,
      high,
      low,
      close,
      volume,
    });
  }

  return candles;
}

function getCoinGeckoTimeframePlan(timeframe: OhlcvTimeframe): CoinGeckoTimeframePlan {
  switch (timeframe) {
    case '1s':
      return { timeframe: 'second', aggregate: 1 };
    case '10s':
      return { timeframe: 'second', aggregate: 1, localAggregateTo: '10s' };
    case '30s':
      return { timeframe: 'second', aggregate: 30 };
    case '1min':
      return { timeframe: 'minute', aggregate: 1 };
    case '5min':
      return { timeframe: 'minute', aggregate: 5 };
    case '10min':
      return { timeframe: 'minute', aggregate: 5, localAggregateTo: '10min' };
    case '30min':
      return { timeframe: 'minute', aggregate: 15, localAggregateTo: '30min' };
    case '1h':
      return { timeframe: 'hour', aggregate: 1 };
    case '4h':
      return { timeframe: 'hour', aggregate: 4 };
    case '6h':
      return { timeframe: 'hour', aggregate: 1, localAggregateTo: '6h' };
    case '12h':
      return { timeframe: 'hour', aggregate: 12 };
    case '1d':
      return { timeframe: 'day', aggregate: 1 };
    case '1w':
      return { timeframe: 'day', aggregate: 1, localAggregateTo: '1w' };
    case '1M':
      return { timeframe: 'day', aggregate: 1, localAggregateTo: '1M' };
  }
}

function toCoinGeckoNetwork(chain: string) {
  const normalized = chain.trim().toLowerCase();
  const map: Record<string, string> = {
    '0': 'solana',
    sol: 'solana',
    solana: 'solana',
    '1': 'eth',
    '0x1': 'eth',
    eth: 'eth',
    ethereum: 'eth',
    '56': 'bsc',
    '0x38': 'bsc',
    bsc: 'bsc',
    binance: 'bsc',
    '8453': 'base',
    '0x2105': 'base',
    base: 'base',
    '42161': 'arbitrum',
    '0xa4b1': 'arbitrum',
    arbitrum: 'arbitrum',
    arbitrum_one: 'arbitrum',
    '146': 'sonic',
    '0x92': 'sonic',
    sonic: 'sonic',
  };
  const network = map[normalized];

  if (!network) {
    throw new Error(`Unsupported CoinGecko network for chain: ${chain}`);
  }

  return network;
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
    const volume = bucketCandles.reduce((sum, candle) => sum + (Number(candle.volume) || 0), 0);
    const trades = bucketCandles.reduce((sum, candle) => sum + (Number(candle.trades) || 0), 0);

    return {
      timestamp,
      open: Number(first.open),
      high: Math.max(...bucketCandles.map((candle) => Number(candle.high))),
      low: Math.min(...bucketCandles.map((candle) => Number(candle.low))),
      close: Number(last.close),
      volume,
      ...(trades > 0 ? { trades } : {}),
    };
  });
}
