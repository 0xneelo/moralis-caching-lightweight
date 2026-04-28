import { buildChartCacheKey, getChartCacheTtl, getJsonCache, setJsonCache } from '../cache.js';
import { config } from '../config.js';
import { findMissingRanges } from '../gaps.js';
import { buildGapFetchLockKey, withRedisLock } from '../locks.js';
import { fetchMoralisOhlcv } from '../moralis.js';
import { enforceChartRateLimit, enforceProviderMissRateLimit } from '../rateLimit.js';
import { enqueueBackfillJob } from '../jobs/enqueue.js';
import { candleRepository } from '../repositories/candles.js';
import { pairRepository } from '../repositories/pairs.js';
import { providerUsageRepository } from '../repositories/providerUsage.js';
import { assertChartRangeAllowed, estimateCandleCount } from '../timeframes.js';
import type {
  ChartCandle,
  ChartOhlcvResponse,
  OhlcvCurrency,
  OhlcvTimeframe,
  StoredCandle,
} from '../types.js';

export async function getOhlcvForChart(params: {
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  from: Date;
  to: Date;
  userId?: string | undefined;
  ip: string;
}): Promise<ChartOhlcvResponse> {
  const pairAddress = params.pairAddress.toLowerCase();

  assertChartRangeAllowed({
    timeframe: params.timeframe,
    from: params.from,
    to: params.to,
  });

  await enforceChartRateLimit({
    userId: params.userId,
    ip: params.ip,
    pairAddress,
  });

  await pairRepository.touchPair({
    chain: params.chain,
    pairAddress,
  });

  const cacheKey = buildChartCacheKey({ ...params, pairAddress });
  const cached = await getJsonCache<ChartOhlcvResponse>(cacheKey);

  if (cached) {
    return cached;
  }

  let storedCandles = await candleRepository.findCandles({
    chain: params.chain,
    pairAddress,
    timeframe: params.timeframe,
    currency: params.currency,
    from: params.from,
    to: params.to,
  });

  const gaps = findMissingRanges({
    candles: storedCandles,
    timeframe: params.timeframe,
    from: params.from,
    to: params.to,
  });

  let partial = false;

  if (gaps.length > 0) {
    await enforceProviderMissRateLimit({
      userId: params.userId,
      ip: params.ip,
    });
  }

  for (const gap of gaps) {
    const estimatedGapCandles = estimateCandleCount(gap.from, gap.to, params.timeframe);

    if (estimatedGapCandles > config.MAX_SYNC_GAP_CANDLES) {
      await enqueueBackfillJob({
        chain: params.chain,
        pairAddress,
        timeframe: params.timeframe,
        currency: params.currency,
        from: gap.from.toISOString(),
        to: gap.to.toISOString(),
        priority: 'normal',
        reason: 'user_gap',
      });

      partial = true;
      continue;
    }

    const lockKey = buildGapFetchLockKey({
      chain: params.chain,
      pairAddress,
      timeframe: params.timeframe,
      currency: params.currency,
      from: gap.from,
      to: gap.to,
    });

    const fetchResult = await withRedisLock(lockKey, 30_000, async () => {
      const result = await fetchMoralisOhlcv({
        chain: params.chain,
        pairAddress,
        timeframe: params.timeframe,
        currency: params.currency,
        fromDate: gap.from,
        toDate: gap.to,
        maxPages: config.MAX_SYNC_MORALIS_PAGES,
      });

      await candleRepository.upsertCandles({
        chain: params.chain,
        pairAddress,
        timeframe: params.timeframe,
        currency: params.currency,
        candles: result.candles,
      });

      await providerUsageRepository.log({
        provider: 'moralis',
        endpoint: 'getPairCandlesticks',
        chain: params.chain,
        pairAddress,
        timeframe: params.timeframe,
        requestFrom: gap.from,
        requestTo: gap.to,
        httpStatus: 200,
        estimatedCu: result.estimatedCu,
        pages: result.pages,
        durationMs: result.durationMs,
      });

      return result;
    });

    if (!fetchResult || fetchResult.truncated) {
      partial = true;
    }
  }

  storedCandles = await candleRepository.findCandles({
    chain: params.chain,
    pairAddress,
    timeframe: params.timeframe,
    currency: params.currency,
    from: params.from,
    to: params.to,
  });

  const response: ChartOhlcvResponse = {
    chain: params.chain,
    pairAddress,
    timeframe: params.timeframe,
    currency: params.currency,
    from: params.from.toISOString(),
    to: params.to.toISOString(),
    source: partial ? 'partial' : gaps.length > 0 ? 'cache+moralis' : 'cache',
    partial,
    candles: storedCandles.map(toChartCandle),
  };

  await setJsonCache(cacheKey, response, getChartCacheTtl(params.timeframe));

  return response;
}

function toChartCandle(candle: StoredCandle): ChartCandle {
  return {
    time: Math.floor(candle.timestamp.getTime() / 1000),
    timestamp: candle.timestamp.toISOString(),
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: candle.volume === null ? null : Number(candle.volume),
    trades: candle.trades,
  };
}
