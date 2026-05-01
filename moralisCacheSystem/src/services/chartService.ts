import { buildChartCacheKey, getChartCacheTtl, getJsonCache, setJsonCache } from '../cache.js';
import { config } from '../config.js';
import { findMissingRanges } from '../gaps.js';
import { buildGapFetchLockKey, withRedisLock } from '../locks.js';
import { fetchMoralisOhlcv } from '../moralis.js';
import { normalizePairAddress } from '../pairAddress.js';
import { appendInteractionTraceEvent } from '../interactionLog.js';
import { HttpError } from '../httpErrors.js';
import {
  assertExternalApiKeyCuBudgetAvailable,
  enforceChartRateLimit,
  enforceExternalApiKeyCacheMissRateLimit,
  enforceProviderMissRateLimit,
} from '../rateLimit.js';
import { enqueueBackfillJob } from '../jobs/enqueue.js';
import { candleRepository } from '../repositories/candles.js';
import { pairRepository } from '../repositories/pairs.js';
import { providerUsageRepository } from '../repositories/providerUsage.js';
import { alignToCandleStart, assertChartRangeAllowed, estimateCandleCount, timeframeSeconds } from '../timeframes.js';
import type {
  ChartCandle,
  ChartOhlcvResponse,
  OhlcvCurrency,
  OhlcvTimeframe,
  StoredCandle,
} from '../types.js';

const MORALIS_OHLC_CU_COST = 150;

export async function getOhlcvForChart(params: {
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  requestedTimeframe?: OhlcvTimeframe | undefined;
  currency: OhlcvCurrency;
  from: Date;
  to: Date;
  visibleFrom?: Date | undefined;
  visibleTo?: Date | undefined;
  userId?: string | undefined;
  ip: string;
  externalApiKeyId?: string | undefined;
  maxProviderPages?: number | undefined;
  maxProviderFetches?: number | undefined;
  interactionId?: string | undefined;
}): Promise<ChartOhlcvResponse> {
  const pairAddress = normalizePairAddress(params.chain, params.pairAddress);

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

  if (cached?.partial) {
    await appendInteractionTraceEvent(params.interactionId, 'partial_response_cache_bypassed', {
      route: '/api/charts/ohlcv',
      chain: params.chain,
      pairAddress,
      requestedTimeframe: params.requestedTimeframe ?? params.timeframe,
      effectiveTimeframe: params.timeframe,
      from: params.from.toISOString(),
      to: params.to.toISOString(),
      cacheKey,
    });
  }

  if (cached && !cached.partial) {
    await appendInteractionTraceEvent(params.interactionId, 'cache_response_hit', {
      route: '/api/charts/ohlcv',
      chain: params.chain,
      pairAddress,
      requestedTimeframe: params.requestedTimeframe ?? params.timeframe,
      effectiveTimeframe: params.timeframe,
      from: params.from.toISOString(),
      to: params.to.toISOString(),
      cacheKey,
    });
    return {
      ...cached,
      source: cached.source === 'cache+moralis' ? 'cache' : cached.source,
      requestedTimeframe: params.requestedTimeframe ?? params.timeframe,
      candles: cached.candles.map((candle) => ({
        ...candle,
        source: candle.source === 'demo' ? 'demo' : 'cache',
      })),
    };
  }

  let storedCandles = await candleRepository.findCandles({
    chain: params.chain,
    pairAddress,
    timeframe: params.timeframe,
    currency: params.currency,
    from: params.from,
    to: params.to,
  });
  await appendInteractionTraceEvent(params.interactionId, 'candle_cache_lookup', {
    route: '/api/charts/ohlcv',
    chain: params.chain,
    pairAddress,
    requestedTimeframe: params.requestedTimeframe ?? params.timeframe,
    effectiveTimeframe: params.timeframe,
    from: params.from.toISOString(),
    to: params.to.toISOString(),
    cachedCandlesInWindow: storedCandles.length,
  });

  const gaps = findMissingRanges({
    candles: storedCandles,
    timeframe: params.timeframe,
    from: params.from,
    to: params.to,
  });
  const visibleRange = {
    from: params.visibleFrom ?? params.from,
    to: params.visibleTo ?? params.to,
  };
  const prioritizedGaps = prioritizeVisibleGaps(gaps, visibleRange);

  let partial = false;
  let sourceOverride: ChartOhlcvResponse['source'] | undefined;
  const moralisCandleTimes = new Set<number>();
  const maxProviderFetches = params.maxProviderFetches ?? 1;
  let providerFetches = 0;

  if (gaps.length > 0) {
    await appendInteractionTraceEvent(params.interactionId, 'cache_gaps_detected', {
      route: '/api/charts/ohlcv',
      chain: params.chain,
      pairAddress,
      requestedTimeframe: params.requestedTimeframe ?? params.timeframe,
      effectiveTimeframe: params.timeframe,
      gaps: prioritizedGaps.map((gap) => ({
        from: gap.from.toISOString(),
        to: gap.to.toISOString(),
        visible: rangesOverlap(gap, visibleRange),
      })),
    });

    try {
      if (params.externalApiKeyId) {
        await enforceExternalApiKeyCacheMissRateLimit({
          apiKeyId: params.externalApiKeyId,
        });
      } else {
        await enforceProviderMissRateLimit({
          userId: params.userId,
          ip: params.ip,
        });
      }
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 429) {
        partial = true;
        sourceOverride = 'partial';
        providerFetches = maxProviderFetches;
        await appendInteractionTraceEvent(params.interactionId, 'provider_fetch_rate_limited_cache_only', {
          route: '/api/charts/ohlcv',
          chain: params.chain,
          pairAddress,
          requestedTimeframe: params.requestedTimeframe ?? params.timeframe,
          effectiveTimeframe: params.timeframe,
          from: params.from.toISOString(),
          to: params.to.toISOString(),
          reason: error.message,
        });
      } else {
        throw error;
      }
    }
  }

  for (const gap of prioritizedGaps) {
    if (providerFetches >= maxProviderFetches) {
      partial = true;
      continue;
    }

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

    const maxPages = params.maxProviderPages ?? config.MAX_SYNC_MORALIS_PAGES;

    const fetchResult = await withRedisLock(lockKey, 30_000, async () => {
      providerFetches += 1;

      if (params.externalApiKeyId) {
        await assertExternalApiKeyCuBudgetAvailable({
          apiKeyId: params.externalApiKeyId,
          estimatedCu: maxPages * MORALIS_OHLC_CU_COST,
        });
      }

      const result = await fetchMoralisOhlcv({
        chain: params.chain,
        pairAddress,
        timeframe: params.timeframe,
        currency: params.currency,
        fromDate: gap.from,
        toDate: gap.to,
        maxPages,
        interactionId: params.interactionId,
      });
      for (const candle of result.candles) {
        moralisCandleTimes.add(Math.floor(new Date(candle.timestamp).getTime() / 1000));
      }

      await candleRepository.upsertCandles({
        chain: params.chain,
        pairAddress,
        timeframe: params.timeframe,
        currency: params.currency,
        candles: result.candles,
      });

      const usageLogParams =
        params.externalApiKeyId === undefined
          ? {
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
            }
          : {
              provider: 'moralis',
              endpoint: 'getPairCandlesticks',
              externalApiKeyId: params.externalApiKeyId,
              chain: params.chain,
              pairAddress,
              timeframe: params.timeframe,
              requestFrom: gap.from,
              requestTo: gap.to,
              httpStatus: 200,
              estimatedCu: result.estimatedCu,
              pages: result.pages,
              durationMs: result.durationMs,
            };

      await providerUsageRepository.log(usageLogParams);

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
    requestedTimeframe: params.requestedTimeframe ?? params.timeframe,
    timeframe: params.timeframe,
    currency: params.currency,
    from: params.from.toISOString(),
    to: params.to.toISOString(),
    source: sourceOverride ?? (partial ? 'partial' : gaps.length > 0 ? 'cache+moralis' : 'cache'),
    partial,
    candles: fillMissingChartCandles(
      storedCandles.map((candle) =>
        toChartCandle(
          candle,
          moralisCandleTimes.has(Math.floor(candle.timestamp.getTime() / 1000)) ? 'moralis' : 'cache'
        )
      ),
      params.from,
      params.to,
      params.timeframe
    ),
  };

  if (!response.partial) {
    await setJsonCache(cacheKey, response, getChartCacheTtl(params.timeframe));
  }

  return response;
}

function toChartCandle(candle: StoredCandle, source: ChartCandle['source'] = 'cache'): ChartCandle {
  return {
    time: Math.floor(candle.timestamp.getTime() / 1000),
    timestamp: candle.timestamp.toISOString(),
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: candle.volume === null ? null : Number(candle.volume),
    trades: candle.trades,
    source,
  };
}

function fillMissingChartCandles(
  inputCandles: ChartCandle[],
  from: Date,
  to: Date,
  timeframe: OhlcvTimeframe
) {
  const candlesByTime = new Map(inputCandles.map((candle) => [candle.time, candle]));
  const stepSeconds = timeframeSeconds[timeframe];
  const fromSeconds = Math.floor(alignToCandleStart(from, timeframe).getTime() / 1000);
  const toSeconds = Math.floor(Math.min(to.getTime(), Date.now()) / 1000);
  const result: ChartCandle[] = [];
  let previousReal: ChartCandle | undefined;

  for (let time = fromSeconds; time < toSeconds; time += stepSeconds) {
    const candle = candlesByTime.get(time);

    if (candle) {
      result.push(candle);
      previousReal = candle.source === 'filled' ? previousReal : candle;
      continue;
    }

    if (previousReal) {
      result.push({
        time,
        timestamp: new Date(time * 1000).toISOString(),
        open: previousReal.close,
        high: previousReal.close,
        low: previousReal.close,
        close: previousReal.close,
        volume: 0,
        trades: 0,
        source: 'filled',
      });
    }
  }

  return result;
}

function prioritizeVisibleGaps(
  gaps: Array<{ from: Date; to: Date }>,
  visibleRange: { from: Date; to: Date }
) {
  return [...gaps].sort((left, right) => {
    const leftVisible = rangesOverlap(left, visibleRange);
    const rightVisible = rangesOverlap(right, visibleRange);

    if (leftVisible !== rightVisible) {
      return leftVisible ? -1 : 1;
    }

    return distanceToRange(left, visibleRange) - distanceToRange(right, visibleRange);
  });
}

function rangesOverlap(left: { from: Date; to: Date }, right: { from: Date; to: Date }) {
  return left.from < right.to && left.to > right.from;
}

function distanceToRange(range: { from: Date; to: Date }, target: { from: Date; to: Date }) {
  if (rangesOverlap(range, target)) {
    return 0;
  }

  if (range.to <= target.from) {
    return target.from.getTime() - range.to.getTime();
  }

  return range.from.getTime() - target.to.getTime();
}
