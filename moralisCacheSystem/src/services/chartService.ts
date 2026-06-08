import { buildChartCacheKey, getChartCacheTtl, getJsonCache, setJsonCache } from '../cache.js';
import { findSuspiciousOhlcRanges, normalizeCandleOhlc } from '../candleQuality.js';
import { getAdminSettings } from '../adminConfig.js';
import { findMissingRanges, prioritizeVisibleRanges } from '../gaps.js';
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
import { marketHistoryStateRepository } from '../repositories/marketHistoryState.js';
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
const CHART_HISTORY_FLOOR = new Date('2024-01-01T00:00:00.000Z');
const DAILY_BOOTSTRAP_TIMEFRAME: OhlcvTimeframe = '1d';

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
  refreshFromMoralis?: boolean | undefined;
}): Promise<ChartOhlcvResponse> {
  const pairAddress = normalizePairAddress(params.chain, params.pairAddress);
  const forceMoralisRefresh = params.refreshFromMoralis === true;

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

  const isDailyRequest = params.timeframe === DAILY_BOOTSTRAP_TIMEFRAME;
  const historyState = await marketHistoryStateRepository.get({
    chain: params.chain,
    pairAddress,
    timeframe: params.timeframe,
    currency: params.currency,
  });
  const dailyHistoryState = isDailyRequest
    ? historyState
    : await marketHistoryStateRepository.get({
        chain: params.chain,
        pairAddress,
        timeframe: DAILY_BOOTSTRAP_TIMEFRAME,
        currency: params.currency,
      });

  let dailyHistoryComplete = dailyHistoryState?.fullHistoryStatus === 'complete';
  let dailyHistoryWarming =
    dailyHistoryState?.fullHistoryStatus === 'queued' || dailyHistoryState?.fullHistoryStatus === 'running';
  let dailyHistoryProgressPct = computeHistoryProgressPct({
    timeframe: DAILY_BOOTSTRAP_TIMEFRAME,
    historyComplete: dailyHistoryComplete,
    latestSyncedTs: dailyHistoryState?.latestSyncedTs ?? null,
  });
  // Do not block interactive intraday chart loads on daily full-history bootstrap.
  // Visible 4h/1h gaps should be fetched immediately; full history can backfill separately.
  const requiresDailyBootstrap = false;

  const historyComplete = historyState?.fullHistoryStatus === 'complete';
  let historyWarming =
    historyState?.fullHistoryStatus === 'queued' || historyState?.fullHistoryStatus === 'running';
  let historyProgressPct = computeHistoryProgressPct({
    timeframe: params.timeframe,
    historyComplete,
    latestSyncedTs: historyState?.latestSyncedTs ?? null,
  });
  const fullHistoryRequested = isFullHistoryRangeRequest({
    timeframe: params.timeframe,
    from: params.from,
    to: params.to,
  });
  const dailyBackfillQueued = false;
  if (dailyBackfillQueued) {
    dailyHistoryWarming = true;
  }
  if (dailyHistoryWarming && dailyHistoryProgressPct === null) {
    dailyHistoryProgressPct = 0;
  }

  const fullHistoryBackfillQueued = fullHistoryRequested && !requiresDailyBootstrap
    ? await ensureFullHistoryBackfillQueuedIfNeeded({
        chain: params.chain,
        pairAddress,
        timeframe: params.timeframe,
        currency: params.currency,
        interactionId: params.interactionId,
        historyState,
      })
    : false;
  historyWarming = historyWarming || fullHistoryBackfillQueued;
  if (fullHistoryBackfillQueued && historyProgressPct === null) {
    historyProgressPct = 0;
  }
  if (requiresDailyBootstrap) {
    historyWarming = true;
    historyProgressPct = dailyHistoryProgressPct ?? 0;
  }

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

  if (
    cached &&
    !cached.partial &&
    !forceMoralisRefresh &&
    !requiresDailyBootstrap &&
    !(fullHistoryRequested && !historyComplete)
  ) {
    await appendInteractionTraceEvent(params.interactionId, 'cache_response_hit', {
      route: '/api/charts/ohlcv',
      chain: params.chain,
      pairAddress,
      requestedTimeframe: params.requestedTimeframe ?? params.timeframe,
      effectiveTimeframe: params.timeframe,
      from: params.from.toISOString(),
      to: params.to.toISOString(),
      cacheKey,
      historyComplete,
      historyWarming,
    });

    return {
      ...cached,
      source: cached.source === 'cache+moralis' ? 'cache' : cached.source,
      requestedTimeframe: params.requestedTimeframe ?? params.timeframe,
      historyComplete: cached.historyComplete ?? historyComplete,
      historyWarming: cached.historyWarming ?? historyWarming,
      historyProgressPct: cached.historyProgressPct ?? historyProgressPct,
      marketStart:
        cached.marketStart ??
        historyState?.marketStartTs?.toISOString() ??
        dailyHistoryState?.marketStartTs?.toISOString() ??
        null,
      candles: cached.candles.map((candle) => ({
        ...normalizeChartCandle(candle),
        source: candle.source === 'demo' ? 'demo' : 'cache',
      })),
    };
  }

  if (cached && !cached.partial && fullHistoryRequested && !historyComplete) {
    await appendInteractionTraceEvent(params.interactionId, 'history_incomplete_cache_bypassed', {
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

  const missingRanges = forceMoralisRefresh
    ? []
    : findMissingRanges({
        candles: storedCandles,
        timeframe: params.timeframe,
        from: params.from,
        to: params.to,
      });
  const suspiciousRanges = forceMoralisRefresh
    ? []
    : findSuspiciousRanges({
        timeframe: params.timeframe,
        candles: storedCandles,
      });
  const fetchRanges = forceMoralisRefresh
    ? [{ from: params.from, to: params.to }]
    : mergeFetchRanges([...missingRanges, ...suspiciousRanges], params.timeframe);
  const visibleRange = {
    from: params.visibleFrom ?? params.from,
    to: params.visibleTo ?? params.to,
  };
  const prioritizedGaps = prioritizeVisibleRanges(fetchRanges, visibleRange);

  if (forceMoralisRefresh) {
    await appendInteractionTraceEvent(params.interactionId, 'manual_refresh_from_moralis_requested', {
      route: '/api/charts/ohlcv',
      chain: params.chain,
      pairAddress,
      requestedTimeframe: params.requestedTimeframe ?? params.timeframe,
      effectiveTimeframe: params.timeframe,
      from: params.from.toISOString(),
      to: params.to.toISOString(),
    });
  }

  if (suspiciousRanges.length > 0) {
    await appendInteractionTraceEvent(params.interactionId, 'cache_quality_ranges_detected', {
      route: '/api/charts/ohlcv',
      chain: params.chain,
      pairAddress,
      requestedTimeframe: params.requestedTimeframe ?? params.timeframe,
      effectiveTimeframe: params.timeframe,
      ranges: suspiciousRanges.map((range) => ({
        from: range.from.toISOString(),
        to: range.to.toISOString(),
      })),
    });
  }

  let partial = false;
  let sourceOverride: ChartOhlcvResponse['source'] | undefined;
  const moralisCandleTimes = new Set<number>();
  const maxProviderFetches = params.maxProviderFetches ?? 1;
  let providerFetches = 0;
  const shouldFetchFromMoralis = !requiresDailyBootstrap;

  if (fetchRanges.length > 0) {
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

    if (!shouldFetchFromMoralis) {
      partial = true;
      sourceOverride = 'partial';
      providerFetches = maxProviderFetches;
      await appendInteractionTraceEvent(params.interactionId, 'provider_fetch_blocked_until_1d_complete', {
        route: '/api/charts/ohlcv',
        chain: params.chain,
        pairAddress,
        requestedTimeframe: params.requestedTimeframe ?? params.timeframe,
        effectiveTimeframe: params.timeframe,
        bootstrapTimeframe: DAILY_BOOTSTRAP_TIMEFRAME,
        historyWarming: dailyHistoryWarming,
        historyProgressPct: dailyHistoryProgressPct,
      });
    } else {
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
          await providerUsageRepository.logThrottleEvent({
            provider: 'moralis',
            reason: 'provider_miss_rate_limited',
            chain: params.chain,
            pairAddress,
            timeframe: params.timeframe,
            requestFrom: params.from,
            requestTo: params.to,
          });
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
  }

  if (shouldFetchFromMoralis) {
    for (const gap of prioritizedGaps) {
      if (providerFetches >= maxProviderFetches) {
        partial = true;
        await providerUsageRepository.logThrottleEvent({
          provider: 'moralis',
          reason: 'max_provider_fetches_reached',
          chain: params.chain,
          pairAddress,
          timeframe: params.timeframe,
          requestFrom: gap.from,
          requestTo: gap.to,
        });
        continue;
      }

      const estimatedGapCandles = estimateCandleCount(gap.from, gap.to, params.timeframe);

      const settings = await getAdminSettings();

      if (estimatedGapCandles > settings.maxSyncGapCandles) {
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
        await providerUsageRepository.logThrottleEvent({
          provider: 'moralis',
          reason: 'gap_enqueued_too_large_for_sync',
          chain: params.chain,
          pairAddress,
          timeframe: params.timeframe,
          requestFrom: gap.from,
          requestTo: gap.to,
          detailMs: estimatedGapCandles,
        });
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

      const maxPages = params.maxProviderPages ?? settings.maxSyncMoralisPages;

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
        await marketHistoryStateRepository.upsertBoundsFromCandles({
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
  }

  storedCandles = await candleRepository.findCandles({
    chain: params.chain,
    pairAddress,
    timeframe: params.timeframe,
    currency: params.currency,
    from: params.from,
    to: params.to,
  });

  let finalHistoryComplete = historyComplete && !requiresDailyBootstrap;
  let finalHistoryWarming = historyWarming;
  let finalHistoryProgressPct = historyProgressPct;
  let finalMarketStartIso =
    historyState?.marketStartTs?.toISOString() ?? dailyHistoryState?.marketStartTs?.toISOString() ?? null;

  if (fullHistoryRequested && !partial && !requiresDailyBootstrap && storedCandles.length > 0) {
    const bounds = await candleRepository.getBounds({
      chain: params.chain,
      pairAddress,
      timeframe: params.timeframe,
      currency: params.currency,
    });
    await marketHistoryStateRepository.markCompleted({
      chain: params.chain,
      pairAddress,
      timeframe: params.timeframe,
      currency: params.currency,
      marketStartTs: bounds.minTimestamp,
      latestSyncedTs: bounds.maxTimestamp,
    });
    finalHistoryComplete = true;
    finalHistoryWarming = false;
    finalHistoryProgressPct = 100;
    finalMarketStartIso = bounds.minTimestamp?.toISOString() ?? null;
  } else if (fullHistoryRequested && !finalHistoryComplete && fetchRanges.length > 0) {
    finalHistoryWarming = true;
    finalHistoryProgressPct = computeHistoryProgressPct({
      timeframe: params.timeframe,
      historyComplete: finalHistoryComplete,
      latestSyncedTs: storedCandles.at(-1)?.timestamp ?? historyState?.latestSyncedTs ?? null,
    });
  }
  if (requiresDailyBootstrap) {
    finalHistoryComplete = false;
    finalHistoryWarming = true;
    finalHistoryProgressPct = dailyHistoryProgressPct ?? (dailyHistoryWarming ? 0 : null);
    finalMarketStartIso = dailyHistoryState?.marketStartTs?.toISOString() ?? finalMarketStartIso;
  }

  const response: ChartOhlcvResponse = {
    chain: params.chain,
    pairAddress,
    requestedTimeframe: params.requestedTimeframe ?? params.timeframe,
    timeframe: params.timeframe,
    currency: params.currency,
    from: params.from.toISOString(),
    to: params.to.toISOString(),
    source: sourceOverride ?? (partial ? 'partial' : fetchRanges.length > 0 ? 'cache+moralis' : 'cache'),
    partial,
    historyComplete: finalHistoryComplete,
    historyWarming: finalHistoryWarming,
    historyProgressPct: finalHistoryProgressPct,
    marketStart: finalMarketStartIso,
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

function findSuspiciousRanges(params: {
  timeframe: OhlcvTimeframe;
  candles: StoredCandle[];
}) {
  const shouldCheckQuality = ['1h', '4h', '6h', '12h', '1d'].includes(params.timeframe);

  if (!shouldCheckQuality) {
    return [] as Array<{ from: Date; to: Date }>;
  }

  return findSuspiciousOhlcRanges(
    params.candles
      .map((candle) => {
        const normalized = normalizeCandleOhlc({
          open: Number(candle.open),
          high: Number(candle.high),
          low: Number(candle.low),
          close: Number(candle.close),
        });
        if (!normalized) {
          return null;
        }
        return {
          timestamp: candle.timestamp,
          ...normalized,
        };
      })
      .filter(
        (
          candle
        ): candle is {
          timestamp: Date;
          open: number;
          high: number;
          low: number;
          close: number;
        } => candle !== null
      ),
    timeframeSeconds[params.timeframe] * 1000
  );
}

function mergeFetchRanges(ranges: Array<{ from: Date; to: Date }>, timeframe: OhlcvTimeframe) {
  if (ranges.length === 0) {
    return [];
  }

  const sorted = [...ranges].sort((left, right) => left.from.getTime() - right.from.getTime());
  const first = sorted[0];
  if (!first) {
    return [];
  }
  const stepMs = timeframeSeconds[timeframe] * 1000;
  const merged: Array<{ from: Date; to: Date }> = [];

  let currentFrom = first.from.getTime();
  let currentTo = first.to.getTime();

  for (let index = 1; index < sorted.length; index += 1) {
    const next = sorted[index];
    if (!next) {
      continue;
    }
    const nextFrom = next.from.getTime();
    const nextTo = next.to.getTime();

    if (nextFrom <= currentTo + stepMs) {
      currentTo = Math.max(currentTo, nextTo);
      continue;
    }

    merged.push({
      from: new Date(currentFrom),
      to: new Date(currentTo),
    });
    currentFrom = nextFrom;
    currentTo = nextTo;
  }

  merged.push({
    from: new Date(currentFrom),
    to: new Date(currentTo),
  });

  return merged;
}

async function ensureFullHistoryBackfillQueuedIfNeeded(params: {
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  interactionId?: string | undefined;
  historyState:
    | {
        fullHistoryStatus: string;
      }
    | null;
}) {
  const status = params.historyState?.fullHistoryStatus;
  const alreadyQueued = status === 'queued' || status === 'running' || status === 'complete';

  if (alreadyQueued) {
    return status === 'queued' || status === 'running';
  }

  const fullHistoryTo = alignToCandleStart(new Date(), params.timeframe);

  try {
    const enqueueResult = await enqueueBackfillJob({
      chain: params.chain,
      pairAddress: params.pairAddress,
      timeframe: params.timeframe,
      currency: params.currency,
      from: CHART_HISTORY_FLOOR.toISOString(),
      to: fullHistoryTo.toISOString(),
      priority: 'high',
      reason: 'initial_history_load',
    });

    await marketHistoryStateRepository.markQueued({
      chain: params.chain,
      pairAddress: params.pairAddress,
      timeframe: params.timeframe,
      currency: params.currency,
      historyFloorTs: CHART_HISTORY_FLOOR,
      queueJobId: enqueueResult.queueJobId,
    });

    await appendInteractionTraceEvent(params.interactionId, 'history_backfill_enqueued', {
      route: '/api/charts/ohlcv',
      chain: params.chain,
      pairAddress: params.pairAddress,
      timeframe: params.timeframe,
      currency: params.currency,
      from: CHART_HISTORY_FLOOR.toISOString(),
      to: fullHistoryTo.toISOString(),
      queueJobId: enqueueResult.queueJobId,
    });
    return true;
  } catch (error) {
    await appendInteractionTraceEvent(params.interactionId, 'history_backfill_enqueue_failed', {
      route: '/api/charts/ohlcv',
      chain: params.chain,
      pairAddress: params.pairAddress,
      timeframe: params.timeframe,
      currency: params.currency,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function isFullHistoryRangeRequest(params: {
  timeframe: OhlcvTimeframe;
  from: Date;
  to: Date;
}) {
  const timeframeMs = timeframeSeconds[params.timeframe] * 1000;
  const nearNowThreshold = Date.now() - timeframeMs * 2;
  return params.from.getTime() <= CHART_HISTORY_FLOOR.getTime() && params.to.getTime() >= nearNowThreshold;
}

function computeHistoryProgressPct(params: {
  timeframe: OhlcvTimeframe;
  historyComplete: boolean;
  latestSyncedTs: Date | null;
}) {
  if (params.historyComplete) {
    return 100;
  }

  if (!params.latestSyncedTs) {
    return null;
  }

  const stepMs = timeframeSeconds[params.timeframe] * 1000;
  const nowCeiling = Date.now() - stepMs;
  const latest = Math.min(params.latestSyncedTs.getTime(), nowCeiling);
  const floor = CHART_HISTORY_FLOOR.getTime();
  const totalSpan = Math.max(1, nowCeiling - floor);
  const coveredSpan = Math.max(0, latest - floor);
  const raw = (coveredSpan / totalSpan) * 100;

  return Math.max(0, Math.min(99, Math.floor(raw)));
}

function toChartCandle(candle: StoredCandle, source: ChartCandle['source'] = 'cache'): ChartCandle {
  return normalizeChartCandle({
    time: Math.floor(candle.timestamp.getTime() / 1000),
    timestamp: candle.timestamp.toISOString(),
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: candle.volume === null ? null : Number(candle.volume),
    trades: candle.trades,
    source,
  });
}

function normalizeChartCandle(candle: ChartCandle): ChartCandle {
  const open = Number(candle.open);
  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);

  if (![open, high, low, close].every(Number.isFinite)) {
    return candle;
  }

  const rangeHigh = Math.max(high, low);
  const rangeLow = Math.min(high, low);

  return {
    ...candle,
    open: clamp(open, rangeLow, rangeHigh),
    high: rangeHigh,
    low: rangeLow,
    close: clamp(close, rangeLow, rangeHigh),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
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

function rangesOverlap(left: { from: Date; to: Date }, right: { from: Date; to: Date }) {
  return left.from < right.to && left.to > right.from;
}
