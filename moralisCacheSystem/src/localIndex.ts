import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import {
  CACHE_SNAPSHOT_FORMAT,
  cacheSnapshotSchema,
  countSnapshotCandles,
  type CacheSnapshot,
} from './cacheSnapshot.js';
import { config } from './config.js';
import { findMissingRanges } from './gaps.js';
import { appendInteractionTraceEvent, writeInteractionLogFile } from './interactionLog.js';
import { logger, moralisLogger } from './logger.js';
import { normalizePairAddress } from './pairAddress.js';
import {
  alignToCandleStart,
  assertChartRangeAllowed,
  getEffectiveAdaptiveTimeframe,
  isOhlcvTimeframe,
  timeframeSeconds,
} from './timeframes.js';
import type { ChartCandle, MoralisCandle, OhlcvCurrency, OhlcvTimeframe } from './types.js';

const MORALIS_OHLC_CU_COST = 150;
const MAX_MORALIS_COMPAT_LIMIT = 1000;
const DEFAULT_MORALIS_COMPAT_LIMIT = 100;
const LOCAL_MAX_PROVIDER_PAGES_PER_CHART_REQUEST = 1;
const LOCAL_MAX_PROVIDER_GAPS_PER_CHART_REQUEST = 1;
const LOCAL_OBSERVABILITY_COOLDOWN_WINDOW_MS = 60_000;
const LOCAL_HISTORY_FLOOR = new Date('2024-01-01T00:00:00.000Z');
const LOCAL_EXTERNAL_API_KEY_FILE = '.local-external-api-key';
const LOCAL_PROXY_USAGE_FILE = '.local-proxy-usage.json';
const LOCAL_PROXY_USAGE_EVENTS_FILE = '.local-proxy-usage.jsonl';
const LOCAL_THROTTLE_EVENTS_FILE = '.local-provider-throttle-events.jsonl';
const candles = new Map<string, ChartCandle[]>();
const responses = new Map<string, unknown>();
const marketHistoryState = new Map<
  string,
  {
    historyComplete: boolean;
    historyWarming: boolean;
    historyProgressPct: number | null;
    marketStart: string | null;
  }
>();
const activeProviderFetches = new Set<string>();
const providerFetchCooldowns = new Map<string, number>();
let persistentCacheInventorySnapshot: Array<{
  chain: string;
  pairAddress: string;
  timeframe: string;
  currency: string;
  candleCount: number;
  firstCandleAt: string | null;
  lastCandleAt: string | null;
  updatedAt: string | null;
}> = [];
let persistentCacheSnapshotLoaded = false;

type MoralisCompatCursor = {
  beforeDate: string;
  effectiveTimeframe: OhlcvTimeframe;
};

type LocalProxyUsage = {
  todayCu: number;
  totalCu: number;
  todayRequests: number;
  totalRequests: number;
  since: string;
  updatedAt: string;
  storage: {
    summaryFile: string;
    eventsFile: string;
  };
};

type LocalProxyUsageEvent = {
  timestamp: string;
  provider: 'moralis';
  endpoint: 'getPairCandlesticks';
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  requestFrom: string;
  requestTo: string;
  pages: number;
  estimatedCu: number;
  returnedCandles: number;
  mode: 'local-memory';
};

type LocalThrottleEvent = {
  timestamp: string;
  reason:
    | 'would_have_provider_cooldown'
    | 'provider_fetch_already_active'
    | 'max_provider_fetches_reached';
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  requestFrom: string;
  requestTo: string;
  detailMs: number | null;
  mode: 'local-memory';
};

const usage = await loadLocalProxyUsage();
const localAdminSettings = {
  moralisOhlcvEnabled: config.CHART_PROVIDER_ENABLED,
  moralisDailyCuBudget: config.MORALIS_DAILY_CU_BUDGET,
  maxSyncMoralisPages: config.MAX_SYNC_MORALIS_PAGES,
  maxSyncGapCandles: config.MAX_SYNC_GAP_CANDLES,
  externalApiKeyRequestRateLimit: config.EXTERNAL_API_KEY_REQUEST_RATE_LIMIT,
  externalApiKeyCacheMissRateLimit: config.EXTERNAL_API_KEY_CACHE_MISS_RATE_LIMIT,
  externalApiKeyDailyCuBudget: config.EXTERNAL_API_KEY_DAILY_CU_BUDGET,
};

const chartQuerySchema = z.object({
  chain: z.string().min(1),
  pairAddress: z.string().min(1),
  timeframe: z.custom<OhlcvTimeframe>((value) => typeof value === 'string' && isOhlcvTimeframe(value), {
    message: 'Unsupported timeframe',
  }),
  currency: z.enum(['usd', 'native']).default('usd'),
  from: z.string().datetime(),
  to: z.string().datetime(),
  visibleFrom: z.string().datetime().optional(),
  visibleTo: z.string().datetime().optional(),
  requestedTimeframe: z
    .custom<OhlcvTimeframe>((value) => typeof value === 'string' && isOhlcvTimeframe(value), {
      message: 'Unsupported requested timeframe',
    })
    .optional(),
  refreshFromMoralis: z
    .string()
    .optional()
    .transform((value) => value === 'true'),
  provider: z.enum(['moralis', 'coingecko']).default('moralis'),
});

const moralisCompatQuerySchema = z.object({
  chain: z.string().min(1).optional(),
  timeframe: z.custom<OhlcvTimeframe>((value) => typeof value === 'string' && isOhlcvTimeframe(value), {
    message: 'Unsupported timeframe',
  }),
  currency: z.enum(['usd', 'native']).default('usd'),
  fromDate: z.string().datetime(),
  toDate: z.string().datetime(),
  limit: z.coerce.number().int().optional(),
  cursor: z.string().min(1).optional(),
  provider: z.enum(['moralis', 'coingecko']).default('moralis'),
});

const tokenOhlcCountbackQuerySchema = z.object({
  pairAddress: z.string().min(1),
  chainId: z.string().min(1),
  to: z.coerce.number().int().positive(),
  resolution: z.string().min(1),
  countBack: z.coerce.number().int().positive(),
  currency: z.enum(['usd', 'native']).default(config.DEFAULT_CURRENCY),
  provider: z.enum(['moralis', 'coingecko']).default('moralis'),
});

const localExternalApiKey = await ensureLocalExternalApiKey();

const app = Fastify({
  loggerInstance: logger,
  trustProxy: true,
  bodyLimit: 100 * 1024 * 1024,
});

await app.register(cors, {
  origin: true,
});

app.get('/health', async () => ({
  ok: true,
  mode: 'local-memory',
  timestamp: new Date().toISOString(),
}));

app.get('/api/usage/moralis', async () => usage);
app.get('/api/usage/moralis/cooldown-skips', async (request) => {
  const parsed = z
    .object({
      limit: z.coerce.number().int().positive().max(1000).optional(),
    })
    .safeParse(request.query);
  const limit = parsed.success ? parsed.data.limit : undefined;

  return {
    events: await readLocalThrottleEvents(limit ?? 200),
  };
});

app.get('/api/admin/session', async (request, reply) => {
  if (!assertLocalAdmin(request.headers.authorization?.toString())) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  return { ok: true, settings: localAdminSettings };
});

app.get('/api/admin/dashboard', async (request, reply) => {
  if (!assertLocalAdmin(request.headers.authorization?.toString())) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const cacheInventory = getAdminCacheInventory(100);

  return {
    usage,
    breakdown: await buildLocalAdminBreakdown(),
    runtimeMode: persistentCacheSnapshotLoaded ? 'persistent-snapshot' : 'local-memory',
    apiKeys: [
      {
        id: 'local-external-api-key',
        name: 'Local external API key',
        keyPrefix: localExternalApiKey.slice(0, 16),
        scopes: ['ohlcv:read'],
        active: true,
        requestCount: usage.totalRequests,
        createdAt: usage.since,
        lastUsedAt: usage.updatedAt,
        revokedAt: null,
      },
    ],
    cacheInventory,
    throttleEvents: await readLocalThrottleEvents(50),
    settings: localAdminSettings,
    updatedAt: new Date().toISOString(),
  };
});

app.get('/api/admin/settings', async (request, reply) => {
  if (!assertLocalAdmin(request.headers.authorization?.toString())) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  return { settings: localAdminSettings };
});

app.patch('/api/admin/settings', async (request, reply) => {
  if (!assertLocalAdmin(request.headers.authorization?.toString())) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const parsed = z
    .object({
      moralisOhlcvEnabled: z.boolean().optional(),
      moralisDailyCuBudget: z.number().int().positive().optional(),
      maxSyncMoralisPages: z.number().int().positive().optional(),
      maxSyncGapCandles: z.number().int().positive().optional(),
      externalApiKeyRequestRateLimit: z.number().int().positive().optional(),
      externalApiKeyCacheMissRateLimit: z.number().int().positive().optional(),
      externalApiKeyDailyCuBudget: z.number().int().positive().optional(),
    })
    .safeParse(request.body);

  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.issues.map((issue) => issue.message).join(', ') });
  }

  Object.assign(localAdminSettings, parsed.data);
  return { settings: localAdminSettings };
});

app.get('/api/admin/cache/inventory', async (request, reply) => {
  if (!assertLocalAdmin(request.headers.authorization?.toString())) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const parsed = z
    .object({ limit: z.coerce.number().int().positive().max(500).optional() })
    .safeParse(request.query);

  const limit = parsed.success ? parsed.data.limit ?? 100 : 100;
  const markets = getAdminCacheInventory(limit);
  return { markets };
});

app.post('/api/admin/cache/load-persistent', async (request, reply) => {
  if (!assertLocalAdmin(request.headers.authorization?.toString())) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const parsed = z
    .object({ limit: z.coerce.number().int().positive().max(500).optional() })
    .safeParse(request.body);

  const limit = parsed.success ? parsed.data.limit ?? 100 : 100;

  try {
    const markets = await loadPersistentCacheInventory(limit);
    persistentCacheInventorySnapshot = markets;
    persistentCacheSnapshotLoaded = true;
    return {
      mode: 'persistent-snapshot',
      importedMarkets: markets.length,
      markets: getAdminCacheInventory(limit),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Persistent cache load failed';
    return reply.status(503).send({ error: message });
  }
});

app.get('/api/admin/cache/export', async (request, reply) => {
  if (!assertLocalAdmin(request.headers.authorization?.toString())) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const snapshot = await buildCurrentLocalExportSnapshot();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  reply
    .header('Content-Type', 'application/json')
    .header('Content-Disposition', `attachment; filename="moralis-cache-${timestamp}.json"`);

  return snapshot;
});

app.post('/api/admin/cache/import', async (request, reply) => {
  if (!assertLocalAdmin(request.headers.authorization?.toString())) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const parsed = cacheSnapshotSchema.safeParse(request.body);

  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.issues.map((issue) => issue.message).join(', ') });
  }

  const result = importSnapshotToLocalMemory(parsed.data);
  return {
    ...result,
    totalSnapshotCandles: countSnapshotCandles(parsed.data),
    markets: getAdminCacheInventory(100),
  };
});

app.post('/api/debug/interactions', async (request, reply) => {
  const parsed = z
    .object({
      event: z.enum(['chart_range_click', 'candle_resolution_click']),
      interactionId: z.string().min(1).optional(),
      selectedValue: z.string().min(1),
      previousValue: z.string().min(1).optional(),
      chain: z.string().min(1).optional(),
      pairAddress: z.string().min(1).optional(),
      requestedTimeframe: z.string().min(1).optional(),
      effectiveTimeframe: z.string().min(1).optional(),
      chartRange: z.string().min(1).optional(),
      visibleFrom: z.string().datetime().optional(),
      visibleTo: z.string().datetime().optional(),
      loadedCandles: z.number().int().nonnegative().optional(),
      source: z.string().min(1).optional(),
    })
    .safeParse(request.body);

  if (!parsed.success) {
    return reply.status(400).send({
      error: parsed.error.issues.map((issue) => issue.message).join(', '),
    });
  }

  const result = await writeInteractionLogFile({
    ...parsed.data,
    mode: 'local-memory',
  });

  return { ok: true, ...result };
});

app.get('/api/charts/ohlcv', async (request, reply) => {
  const parsed = chartQuerySchema.safeParse(request.query);

  if (!parsed.success) {
    return reply.status(400).send({
      error: parsed.error.issues.map((issue) => issue.message).join(', '),
    });
  }

  if (parsed.data.provider !== 'moralis') {
    return reply.status(400).send({ error: 'Local memory mode currently supports provider=moralis only' });
  }

  const pairAddress = normalizePairAddress(parsed.data.chain, parsed.data.pairAddress);
  const from = new Date(parsed.data.from);
  const to = new Date(parsed.data.to);
  const visibleFrom = parsed.data.visibleFrom ? new Date(parsed.data.visibleFrom) : from;
  const visibleTo = parsed.data.visibleTo ? new Date(parsed.data.visibleTo) : to;
  const requestedTimeframe = parsed.data.requestedTimeframe ?? parsed.data.timeframe;
  const interactionId = request.headers['x-interaction-id']?.toString();
  const refreshFromMoralis = parsed.data.refreshFromMoralis;
  const effectiveTimeframe = getEffectiveAdaptiveTimeframe({
    requestedTimeframe,
    from: visibleFrom,
    to: visibleTo,
  });

  try {
    assertChartRangeAllowed({
      timeframe: effectiveTimeframe,
      from,
      to,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid chart request';

    if (!message.startsWith('Requested range is too large')) {
      return reply.status(400).send({
        error: message,
      });
    }

    logger.warn(
      {
        requestedTimeframe,
        effectiveTimeframe,
        from: from.toISOString(),
        to: to.toISOString(),
      },
      'Allowing oversized chart range in local-memory mode after adaptive timeframe normalization.'
    );
  }

  const responseKey = buildKey({
    chain: parsed.data.chain,
    pairAddress,
    timeframe: effectiveTimeframe,
    currency: parsed.data.currency,
    from,
    to,
  });
  const historyKey = buildHistoryStateKey({
    chain: parsed.data.chain,
    pairAddress,
    timeframe: effectiveTimeframe,
    currency: parsed.data.currency,
  });
  const historyState = marketHistoryState.get(historyKey) ?? {
    historyComplete: false,
    historyWarming: false,
    historyProgressPct: null,
    marketStart: null,
  };
  const fullHistoryRequested = isLocalFullHistoryRangeRequest({
    timeframe: effectiveTimeframe,
    from,
    to,
  });

  const cachedResponse = responses.get(responseKey);
  if (cachedResponse && isPartialChartResponse(cachedResponse)) {
    await appendInteractionTraceEvent(interactionId, 'partial_response_cache_bypassed', {
      route: '/api/charts/ohlcv',
      chain: parsed.data.chain,
      pairAddress,
      requestedTimeframe,
      effectiveTimeframe,
      from: from.toISOString(),
      to: to.toISOString(),
      cacheKey: responseKey,
    });
  }

  if (cachedResponse && !isPartialChartResponse(cachedResponse) && !(fullHistoryRequested && !historyState.historyComplete)) {
    await appendInteractionTraceEvent(interactionId, 'cache_response_hit', {
      route: '/api/charts/ohlcv',
      chain: parsed.data.chain,
      pairAddress,
      requestedTimeframe,
      effectiveTimeframe,
      from: from.toISOString(),
      to: to.toISOString(),
      cacheKey: responseKey,
      historyComplete: historyState.historyComplete,
    });
    const cacheDebugResponse = markCachedResponseCandles(cachedResponse);
    reply.header('x-requested-timeframe', requestedTimeframe);
    reply.header('x-effective-timeframe', effectiveTimeframe);
    if (
      typeof cacheDebugResponse === 'object' &&
      cacheDebugResponse !== null &&
      'source' in cacheDebugResponse &&
      typeof cacheDebugResponse.source === 'string'
    ) {
      reply.header('x-cache-source', cacheDebugResponse.source);
    }
    if (typeof cacheDebugResponse === 'object' && cacheDebugResponse !== null) {
      return {
        ...cacheDebugResponse,
        historyComplete: historyState.historyComplete,
        historyWarming: historyState.historyWarming,
        historyProgressPct: historyState.historyProgressPct,
        marketStart: historyState.marketStart,
      };
    }

    return {
      historyComplete: historyState.historyComplete,
      historyWarming: historyState.historyWarming,
      historyProgressPct: historyState.historyProgressPct,
      marketStart: historyState.marketStart,
      candles: [],
    };
  }

  if (cachedResponse && !isPartialChartResponse(cachedResponse) && fullHistoryRequested && !historyState.historyComplete) {
    await appendInteractionTraceEvent(interactionId, 'history_incomplete_cache_bypassed', {
      route: '/api/charts/ohlcv',
      chain: parsed.data.chain,
      pairAddress,
      requestedTimeframe,
      effectiveTimeframe,
      from: from.toISOString(),
      to: to.toISOString(),
      cacheKey: responseKey,
    });
  }

  const candleKey = buildCandleKey({
    chain: parsed.data.chain,
    pairAddress,
    timeframe: effectiveTimeframe,
    currency: parsed.data.currency,
  });

  let stored = candles.get(candleKey) ?? [];
  const matching = filterCandles(stored, from, to);
  await appendInteractionTraceEvent(interactionId, 'candle_cache_lookup', {
    route: '/api/charts/ohlcv',
    chain: parsed.data.chain,
    pairAddress,
    requestedTimeframe,
    effectiveTimeframe,
    from: from.toISOString(),
    to: to.toISOString(),
    candleKey,
    cachedCandlesInWindow: matching.length,
  });
  const marketStartDate = parseIsoDateOrNull(historyState.marketStart);
  const gaps = filterGapsFromMarketStart(
    findMissingRanges({
      candles: matching.map((candle) => ({ timestamp: new Date(candle.timestamp) })),
      timeframe: effectiveTimeframe,
      from,
      to,
    }),
    marketStartDate
  );
  const prioritizedGaps = prioritizeVisibleGaps(gaps, {
    from: visibleFrom,
    to: visibleTo,
  });
  const moralisCandleTimes = new Set<number>();
  let generatedDemoCandles = false;
  let responseSource: 'cache' | 'cache+moralis' | 'partial' | 'demo' =
    gaps.length === 0 ? 'cache' : 'partial';
  let partial = gaps.length > 0;
  let marketStart = historyState.marketStart;
  let historyComplete = historyState.historyComplete;
  let historyWarming = fullHistoryRequested && !historyState.historyComplete;
  let historyProgressPct = historyState.historyProgressPct;

  if (gaps.length > 0) {
    await appendInteractionTraceEvent(interactionId, 'cache_gaps_detected', {
      route: '/api/charts/ohlcv',
      chain: parsed.data.chain,
      pairAddress,
      requestedTimeframe,
      effectiveTimeframe,
      gaps: prioritizedGaps.map((gap) => ({
        from: gap.from.toISOString(),
        to: gap.to.toISOString(),
        visible: rangesOverlap(gap, { from: visibleFrom, to: visibleTo }),
      })),
    });

    if (!config.MORALIS_API_KEY) {
      logger.warn('MORALIS_API_KEY is missing. Returning demo candles for local UI mode.');
      for (const gap of prioritizedGaps) {
        stored = mergeCandles(
          stored,
          createSyntheticCandlesFromCache(stored, gap.from, gap.to, effectiveTimeframe)
        );
      }
      generatedDemoCandles = true;
      candles.set(candleKey, stored);
      responseSource = 'demo';
    } else {
      let providerGapsFetched = 0;

      for (const gap of gaps) {
        if (providerGapsFetched >= LOCAL_MAX_PROVIDER_GAPS_PER_CHART_REQUEST) {
          logger.warn(
            {
              pairAddress,
              requestedTimeframe,
              effectiveTimeframe,
              remainingGapFrom: gap.from.toISOString(),
              remainingGapTo: gap.to.toISOString(),
            },
            'Skipped additional local Moralis gap fetch to protect CU usage'
          );
          await recordLocalThrottleEvent({
            reason: 'max_provider_fetches_reached',
            chain: parsed.data.chain,
            pairAddress,
            timeframe: effectiveTimeframe,
            currency: parsed.data.currency,
            requestFrom: gap.from,
            requestTo: gap.to,
            detailMs: null,
          });
          partial = true;
          break;
        }

        const providerFetchKey = buildProviderFetchKey({
          chain: parsed.data.chain,
          pairAddress,
          currency: parsed.data.currency,
        });

        if (activeProviderFetches.has(providerFetchKey)) {
          logger.warn(
            {
              pairAddress,
              requestedTimeframe,
              effectiveTimeframe,
              gapFrom: gap.from.toISOString(),
              gapTo: gap.to.toISOString(),
            },
            'Skipped local Moralis fetch because another provider fetch is already active for this pair'
          );
          await recordLocalThrottleEvent({
            reason: 'provider_fetch_already_active',
            chain: parsed.data.chain,
            pairAddress,
            timeframe: effectiveTimeframe,
            currency: parsed.data.currency,
            requestFrom: gap.from,
            requestTo: gap.to,
            detailMs: null,
          });
          partial = true;
          break;
        }

        if (refreshFromMoralis) {
          logger.info(
            {
              pairAddress,
              requestedTimeframe,
              effectiveTimeframe,
              gapFrom: gap.from.toISOString(),
              gapTo: gap.to.toISOString(),
            },
            'refreshFromMoralis=true requested; bypassing observability cooldown marker'
          );
        }

        if (!refreshFromMoralis) {
          const lastProviderFetchAt = providerFetchCooldowns.get(providerFetchKey) ?? 0;
          const cooldownRemainingMs =
            LOCAL_OBSERVABILITY_COOLDOWN_WINDOW_MS - (Date.now() - lastProviderFetchAt);

          if (cooldownRemainingMs > 0) {
            logger.info(
              {
                pairAddress,
                requestedTimeframe,
                effectiveTimeframe,
                cooldownRemainingMs,
                gapFrom: gap.from.toISOString(),
                gapTo: gap.to.toISOString(),
              },
              'Observed request within historical cooldown window; continuing fetch for fast UX'
            );
            await recordLocalThrottleEvent({
              reason: 'would_have_provider_cooldown',
              chain: parsed.data.chain,
              pairAddress,
              timeframe: effectiveTimeframe,
              currency: parsed.data.currency,
              requestFrom: gap.from,
              requestTo: gap.to,
              detailMs: cooldownRemainingMs,
            });
          }
        }

        try {
          providerGapsFetched += 1;
          activeProviderFetches.add(providerFetchKey);
          providerFetchCooldowns.set(providerFetchKey, Date.now());
          const result = await fetchMoralisOhlcvLocal({
            chain: parsed.data.chain,
            pairAddress,
            timeframe: effectiveTimeframe,
            currency: parsed.data.currency,
            from: gap.from,
            to: gap.to,
            maxPages: LOCAL_MAX_PROVIDER_PAGES_PER_CHART_REQUEST,
            interactionId,
          });

          if (result.candles.length === 0) {
            logger.warn(
              {
                pairAddress,
                requestedTimeframe,
                effectiveTimeframe,
                from: gap.from.toISOString(),
                to: gap.to.toISOString(),
              },
              'Moralis returned zero candles for local gap. Returning cached candles only.'
            );
            partial = true;
          } else {
            const fetchedCandles = result.candles.map(toChartCandle);
            for (const candle of fetchedCandles) {
              moralisCandleTimes.add(candle.time);
            }
            if (fetchedCandles.length > 0) {
              const earliestFetched = fetchedCandles.reduce((earliest, candle) =>
                !earliest || candle.time < earliest.time ? candle : earliest
              , null as ChartCandle | null);
              const latestFetched = fetchedCandles.reduce((latest, candle) =>
                !latest || candle.time > latest.time ? candle : latest
              , null as ChartCandle | null);
              if (earliestFetched) {
                marketStart =
                  !marketStart || earliestFetched.timestamp < marketStart
                    ? earliestFetched.timestamp
                    : marketStart;
              }
              if (!historyComplete && latestFetched) {
                historyProgressPct = computeLocalHistoryProgressPct(effectiveTimeframe, latestFetched.timestamp);
              }
            }
            stored = mergeCandles(stored, fetchedCandles);
            const remainingGaps = filterGapsFromMarketStart(
              findMissingRanges({
                candles: filterCandles(stored, gap.from, gap.to).map((candle) => ({
                  timestamp: new Date(candle.timestamp),
                })),
                timeframe: effectiveTimeframe,
                from: gap.from,
                to: gap.to,
              }),
              parseIsoDateOrNull(marketStart)
            );

            responseSource = 'cache+moralis';
            partial = remainingGaps.length > 0;
          }

          candles.set(candleKey, stored);

          logger.info(
            {
              provider: 'moralis',
              pairAddress,
              requestedTimeframe,
              effectiveTimeframe,
              pages: result.pages,
              returnedCandles: result.candles.length,
              estimatedCu: result.pages * MORALIS_OHLC_CU_COST,
              mode: 'local-memory',
            },
            'Fetched local missing candles from Moralis'
          );

          await recordMoralisUsage({
            chain: parsed.data.chain,
            pairAddress,
            timeframe: effectiveTimeframe,
            currency: parsed.data.currency,
            requestFrom: gap.from,
            requestTo: gap.to,
            pages: result.pages,
            returnedCandles: result.candles.length,
          });
        } catch (error) {
          logger.error(
            {
              error,
              pairAddress,
              chain: parsed.data.chain,
              requestedTimeframe,
              effectiveTimeframe,
              from: gap.from.toISOString(),
              to: gap.to.toISOString(),
            },
            'Moralis local fetch failed. Returning cached candles only.'
          );
          partial = true;
        } finally {
          activeProviderFetches.delete(providerFetchKey);
        }
      }
    }
  }

  let storedForResponse = candles.get(candleKey) ?? [];
  let fillSeedCandle = findFillSeedCandle({
    chain: parsed.data.chain,
    pairAddress,
    timeframe: effectiveTimeframe,
    currency: parsed.data.currency,
    from,
    sameTimeframeCandles: storedForResponse,
  });

  if (!fillSeedCandle && config.MORALIS_API_KEY && filterCandles(storedForResponse, from, to).length === 0) {
    const seedFrom = getFillSeedLookbackFrom(from, effectiveTimeframe);

    try {
      const seedResult = await fetchMoralisOhlcvLocal({
        chain: parsed.data.chain,
        pairAddress,
        timeframe: effectiveTimeframe,
        currency: parsed.data.currency,
        from: seedFrom,
        to: from,
        maxPages: 1,
        interactionId,
      });
      const seedCandles = seedResult.candles.map(toChartCandle);

      if (seedCandles.length > 0) {
        storedForResponse = mergeCandles(storedForResponse, seedCandles);
        candles.set(candleKey, storedForResponse);
        fillSeedCandle = findLatestCandleBefore(storedForResponse, Math.floor(from.getTime() / 1000));
        responseSource = responseSource === 'partial' ? 'cache+moralis' : responseSource;
        await recordMoralisUsage({
          chain: parsed.data.chain,
          pairAddress,
          timeframe: effectiveTimeframe,
          currency: parsed.data.currency,
          requestFrom: seedFrom,
          requestTo: from,
          pages: seedResult.pages,
          returnedCandles: seedResult.candles.length,
        });
      }
    } catch (error) {
      logger.warn(
        {
          error,
          pairAddress,
          requestedTimeframe,
          effectiveTimeframe,
          seedFrom: seedFrom.toISOString(),
          seedTo: from.toISOString(),
        },
        'Unable to fetch prior seed candle for filler candles.'
      );
    }
  }

  const finalCandles = fillMissingChartCandles(
    filterCandles(storedForResponse, from, to).map((candle) => ({
      ...candle,
      source: generatedDemoCandles
        ? 'demo'
        : moralisCandleTimes.has(candle.time)
          ? 'moralis'
          : 'cache',
    })),
    from,
    to,
    effectiveTimeframe,
    fillSeedCandle
  );
  const response = {
    chain: parsed.data.chain,
    pairAddress,
    requestedTimeframe,
    timeframe: effectiveTimeframe,
    currency: parsed.data.currency,
    from: from.toISOString(),
    to: to.toISOString(),
    source: responseSource,
    partial,
    historyComplete,
    historyWarming,
    historyProgressPct,
    marketStart,
    candles: finalCandles,
  };

  if (fullHistoryRequested && !partial) {
    historyComplete = true;
    historyWarming = false;
    historyProgressPct = 100;
    if (!marketStart) {
      marketStart = finalCandles.find((candle) => candle.source !== 'filled')?.timestamp ?? null;
    }
    response.historyComplete = historyComplete;
    response.historyWarming = historyWarming;
    response.historyProgressPct = historyProgressPct;
    response.marketStart = marketStart;
  } else if (fullHistoryRequested && !historyComplete && gaps.length > 0) {
    historyWarming = true;
    response.historyWarming = true;
    response.historyProgressPct = historyProgressPct ?? 0;
  } else {
    historyWarming = false;
    response.historyWarming = false;
  }

  marketHistoryState.set(historyKey, {
    historyComplete,
    historyWarming,
    historyProgressPct,
    marketStart,
  });

  reply.header('x-requested-timeframe', requestedTimeframe);
  reply.header('x-effective-timeframe', effectiveTimeframe);
  reply.header('x-cache-source', responseSource);
  if (!partial) {
    responses.set(responseKey, response);
  }
  return response;
});

app.get('/api/v2.2/pairs/:pairAddress/ohlcv', async (request, reply) => {
  if (!isLocalExternalApiKeyAllowed(request.headers['x-api-key']?.toString())) {
    return reply.status(401).send({ error: 'Invalid API key' });
  }

  const parsedParams = z.object({ pairAddress: z.string().min(1) }).safeParse(request.params);
  const parsedQuery = moralisCompatQuerySchema.safeParse(request.query);

  if (!parsedParams.success || !parsedQuery.success) {
    const error = parsedQuery.success
      ? 'pairAddress is required'
      : parsedQuery.error.issues.map((issue) => issue.message).join(', ');
    return reply.status(400).send({ error });
  }
  if (parsedQuery.data.provider !== 'moralis') {
    return reply.status(400).send({ error: 'Local memory mode currently supports provider=moralis only' });
  }

  return injectMoralisCompatOhlcv({
    reply,
    chain: normalizeExternalChainId(parsedQuery.data.chain ?? 'eth'),
    pairAddress: parsedParams.data.pairAddress,
    timeframe: parsedQuery.data.timeframe,
    currency: parsedQuery.data.currency,
    fromDate: parsedQuery.data.fromDate,
    toDate: parsedQuery.data.toDate,
    requestedLimit: parsedQuery.data.limit,
    cursor: parsedQuery.data.cursor,
  });
});

app.get('/api/token/ohlc/countback', async (request, reply) => {
  if (!isLocalExternalApiKeyAllowed(request.headers['x-api-key']?.toString())) {
    return reply.status(401).send({ error: 'Invalid API key' });
  }

  const parsed = tokenOhlcCountbackQuerySchema.safeParse(request.query);

  if (!parsed.success) {
    return reply.status(400).send({
      error: parsed.error.issues.map((issue) => issue.message).join(', '),
    });
  }
  if (parsed.data.provider !== 'moralis') {
    return reply.status(400).send({ error: 'Local memory mode currently supports provider=moralis only' });
  }

  const chain = normalizeExternalChainId(parsed.data.chainId);
  let timeframe: OhlcvTimeframe;

  try {
    timeframe = mapExternalResolutionToTimeframe(parsed.data.resolution);
  } catch (error) {
    return reply.status(400).send({
      error: error instanceof Error ? error.message : 'Unsupported resolution',
    });
  }

  const countBack = clampMoralisCompatLimit(parsed.data.countBack);
  const pairAddress = normalizePairAddress(chain, parsed.data.pairAddress);
  const to = new Date(parsed.data.to * 1000);
  const candleKey = buildCandleKey({
    chain,
    pairAddress,
    timeframe,
    currency: parsed.data.currency,
  });
  const storedCandles = [...(candles.get(candleKey) ?? [])]
    .filter((candle) => candle.time <= parsed.data.to && (candle.volume ?? 0) > 0)
    .sort((left, right) => right.time - left.time)
    .slice(0, countBack)
    .sort((left, right) => left.time - right.time);

  if (storedCandles.length < countBack) {
    const from = getCountbackWarmFrom(to, timeframe, countBack);
    const chartQuery = new URLSearchParams({
      chain,
      pairAddress,
      timeframe,
      requestedTimeframe: timeframe,
      currency: parsed.data.currency,
      from: from.toISOString(),
      to: to.toISOString(),
      provider: parsed.data.provider,
    });

    void app.inject({
      method: 'GET',
      url: `/api/charts/ohlcv?${chartQuery.toString()}`,
    }).catch(() => undefined);
  }

  setMoralisCompatHeaders(reply, {
    source: storedCandles.length >= countBack ? 'cache' : 'partial',
    cuUsed: 0,
    requestedTimeframe: timeframe,
    effectiveTimeframe: timeframe,
    effectiveLimit: countBack,
    pageFrom: storedCandles[0] ? new Date(storedCandles[0].timestamp) : null,
    pageTo: to,
  });
  reply.header('x-countback-returned', String(storedCandles.length));

  return toTokenOhlcCountbackBody(storedCandles);
});

app.get('/token/mainnet/pairs/:pairAddress/ohlcv', async (request, reply) => {
  if (!isLocalExternalApiKeyAllowed(request.headers['x-api-key']?.toString())) {
    return reply.status(401).send({ error: 'Invalid API key' });
  }

  const parsedParams = z.object({ pairAddress: z.string().min(1) }).safeParse(request.params);
  const parsedQuery = moralisCompatQuerySchema.omit({ chain: true }).safeParse(request.query);

  if (!parsedParams.success || !parsedQuery.success) {
    const error = parsedQuery.success
      ? 'pairAddress is required'
      : parsedQuery.error.issues.map((issue) => issue.message).join(', ');
    return reply.status(400).send({ error });
  }
  if (parsedQuery.data.provider !== 'moralis') {
    return reply.status(400).send({ error: 'Local memory mode currently supports provider=moralis only' });
  }

  return injectMoralisCompatOhlcv({
    reply,
    chain: 'solana',
    pairAddress: parsedParams.data.pairAddress,
    timeframe: parsedQuery.data.timeframe,
    currency: parsedQuery.data.currency,
    fromDate: parsedQuery.data.fromDate,
    toDate: parsedQuery.data.toDate,
    requestedLimit: parsedQuery.data.limit,
    cursor: parsedQuery.data.cursor,
  });
});

await app.listen({
  host: '0.0.0.0',
  port: config.PORT,
});

logger.info(
  {
    port: config.PORT,
  },
  'Local memory API started. This mode does not require Redis or Postgres.'
);

logger.info(
  {
    baseUrl: `http://localhost:${config.PORT}`,
    apiKey: localExternalApiKey,
  },
  'Local Moralis-compatible API key ready for X-API-Key'
);

async function injectMoralisCompatOhlcv(params: {
  reply: FastifyReply;
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  fromDate: string;
  toDate: string;
  requestedLimit?: number | undefined;
  cursor?: string | undefined;
}) {
  const requestedFrom = new Date(params.fromDate);
  const requestedTo = new Date(params.toDate);
  const effectiveTimeframe = params.timeframe;
  const effectiveLimit = clampMoralisCompatLimit(params.requestedLimit);
  let cursor: MoralisCompatCursor | null;

  try {
    cursor = decodeCursor(params.cursor);
  } catch (error) {
    return params.reply.status(400).send({
      error: error instanceof Error ? error.message : 'Invalid request',
    });
  }

  if (cursor && cursor.effectiveTimeframe !== effectiveTimeframe) {
    return params.reply.status(400).send({ error: 'Invalid cursor' });
  }

  const pageBefore = cursor ? new Date(cursor.beforeDate) : requestedTo;

  if (pageBefore <= requestedFrom) {
    setMoralisCompatHeaders(params.reply, {
      source: 'cache',
      cuUsed: 0,
      requestedTimeframe: params.timeframe,
      effectiveTimeframe,
      effectiveLimit,
      pageFrom: null,
      pageTo: null,
    });

    return {
      cursor: null,
      result: [],
    };
  }

  const beforeCu = usage.totalCu;
  const normalizedPairAddress = normalizePairAddress(params.chain, params.pairAddress);
  const candleKey = buildCandleKey({
    chain: params.chain,
    pairAddress: normalizedPairAddress,
    timeframe: effectiveTimeframe,
    currency: params.currency,
  });
  let pageCandles = [...(candles.get(candleKey) ?? [])]
    .filter((candle) => {
      const timestamp = new Date(candle.timestamp);
      return timestamp >= requestedFrom && timestamp <= requestedTo && (!cursor || timestamp < pageBefore);
    })
    .sort((left, right) => right.time - left.time)
    .slice(0, effectiveLimit + 1);
  let source = 'cache';
  let providerTruncated = false;

  if (pageCandles.length <= effectiveLimit && config.MORALIS_API_KEY) {
    const providerResult = await fetchMoralisOhlcvLocal({
      chain: params.chain,
      pairAddress: normalizedPairAddress,
      timeframe: effectiveTimeframe,
      currency: params.currency,
      from: requestedFrom,
      to: pageBefore,
      maxPages: 1,
    });
    providerTruncated = providerResult.truncated;
    source = 'cache+moralis';
    const fetchedCandles = providerResult.candles.map(toChartCandle);
    candles.set(candleKey, mergeCandles(candles.get(candleKey) ?? [], fetchedCandles));
    await recordMoralisUsage({
      chain: params.chain,
      pairAddress: normalizedPairAddress,
      timeframe: effectiveTimeframe,
      currency: params.currency,
      requestFrom: requestedFrom,
      requestTo: pageBefore,
      pages: providerResult.pages,
      returnedCandles: providerResult.candles.length,
    });
    pageCandles = [...(candles.get(candleKey) ?? [])]
      .filter((candle) => {
        const timestamp = new Date(candle.timestamp);
        return timestamp >= requestedFrom && timestamp <= requestedTo && (!cursor || timestamp < pageBefore);
      })
      .sort((left, right) => right.time - left.time)
      .slice(0, effectiveLimit + 1);
  }

  const cuDelta = usage.totalCu - beforeCu;
  const selectedCandles = pageCandles.slice(0, effectiveLimit);
  const result = selectedCandles.map(toMoralisCompatCandle);
  const nextCursor = (providerTruncated || pageCandles.length > effectiveLimit) && selectedCandles.length > 0
    ? encodeCursor({
        beforeDate: selectedCandles[selectedCandles.length - 1]!.timestamp,
        effectiveTimeframe,
      })
    : null;
  const newestReturned = selectedCandles[0] ? new Date(selectedCandles[0].timestamp) : null;
  const oldestReturned = selectedCandles[selectedCandles.length - 1]
    ? new Date(selectedCandles[selectedCandles.length - 1]!.timestamp)
    : null;

  setMoralisCompatHeaders(params.reply, {
    source,
    cuUsed: cuDelta,
    requestedTimeframe: params.timeframe,
    effectiveTimeframe,
    effectiveLimit,
    pageFrom: oldestReturned,
    pageTo: newestReturned,
  });

  logger.info(
    {
      compatibility: 'moralis',
      chain: params.chain,
      pairAddress: params.pairAddress,
      requestedTimeframe: params.timeframe,
      effectiveTimeframe,
      source,
      returnedCandles: result.length,
      estimatedCu: cuDelta,
      nextCursor: Boolean(nextCursor),
      from: requestedFrom.toISOString(),
      to: requestedTo.toISOString(),
    },
    'Served Moralis-compatible OHLCV request'
  );

  return {
    cursor: nextCursor,
    result,
  };
}

function clampMoralisCompatLimit(requestedLimit: number | undefined) {
  if (typeof requestedLimit !== 'number' || !Number.isFinite(requestedLimit)) {
    return DEFAULT_MORALIS_COMPAT_LIMIT;
  }

  return Math.min(Math.max(1, requestedLimit), MAX_MORALIS_COMPAT_LIMIT);
}

function setMoralisCompatHeaders(
  reply: FastifyReply,
  params: {
    source: string;
    cuUsed: number;
    requestedTimeframe: OhlcvTimeframe;
    effectiveTimeframe: OhlcvTimeframe;
    effectiveLimit: number;
    pageFrom: Date | null;
    pageTo: Date | null;
  }
) {
  reply.header('Cache-Control', 'private, max-age=5');
  reply.header('x-cache-source', params.source);
  reply.header('x-moralis-cu-used', String(params.cuUsed));
  reply.header('x-requested-timeframe', params.requestedTimeframe);
  reply.header('x-effective-timeframe', params.effectiveTimeframe);
  reply.header('x-effective-limit', String(params.effectiveLimit));
  reply.header('x-page-from', params.pageFrom?.toISOString() ?? '');
  reply.header('x-page-to', params.pageTo?.toISOString() ?? '');
}

function toTokenOhlcCountbackBody(storedCandles: ChartCandle[]) {
  return {
    s: storedCandles.length > 0 ? 'ok' : 'no_data',
    t: storedCandles.map((candle) => candle.time),
    o: storedCandles.map((candle) => candle.open),
    h: storedCandles.map((candle) => candle.high),
    l: storedCandles.map((candle) => candle.low),
    c: storedCandles.map((candle) => candle.close),
    v: storedCandles.map((candle) => candle.volume ?? 0),
    result: storedCandles.map(toMoralisCompatCandle),
  };
}

function normalizeExternalChainId(chainId: string) {
  const normalized = chainId.trim().toLowerCase();

  if (normalized === '8453' || normalized === '0x2105') {
    return 'base';
  }

  if (normalized === '1' || normalized === '0x1') {
    return 'eth';
  }

  return normalized;
}

function mapExternalResolutionToTimeframe(resolution: string): OhlcvTimeframe {
  const normalized = resolution.trim().toLowerCase();
  const timeframeByResolution: Record<string, OhlcvTimeframe> = {
    '1': '1min',
    '5': '5min',
    '10': '10min',
    '30': '30min',
    '60': '1h',
    '240': '4h',
    '360': '6h',
    '720': '12h',
    '1d': '1d',
    d: '1d',
    '1w': '1w',
    w: '1w',
    '1m': '1M',
    m: '1M',
  };

  const timeframe = timeframeByResolution[normalized];

  if (!timeframe) {
    throw new Error(`Unsupported resolution: ${resolution}`);
  }

  return timeframe;
}

function getCountbackWarmFrom(to: Date, timeframe: OhlcvTimeframe, countBack: number) {
  const timeframeMs = timeframeSeconds[timeframe] * 1000;
  const overscan = Math.max(countBack * 3, countBack + 100);

  return new Date(to.getTime() - timeframeMs * overscan);
}

function assertLocalAdmin(authorization: string | undefined) {
  const token = authorization?.replace(/^Bearer\s+/i, '').trim();
  const expected = config.ADMIN_API_KEY || localExternalApiKey;

  return Boolean(token && expected && token === expected);
}

async function buildLocalAdminBreakdown() {
  const events = await readLocalUsageEvents(500);
  const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
  const recent24h = events.filter((event) => new Date(event.timestamp).getTime() >= sinceMs);
  const byEndpoint = new Map<string, {
    requestCount: number;
    estimatedCu: number;
    avgDurationMs: null;
    errorCount: number;
  }>();
  const byHour = new Map<string, { requestCount: number; estimatedCu: number }>();

  for (const event of recent24h) {
    const endpoint = byEndpoint.get(event.endpoint) ?? {
      requestCount: 0,
      estimatedCu: 0,
      avgDurationMs: null,
      errorCount: 0,
    };
    endpoint.requestCount += event.pages;
    endpoint.estimatedCu += event.estimatedCu;
    byEndpoint.set(event.endpoint, endpoint);

    const hour = new Date(event.timestamp);
    hour.setUTCMinutes(0, 0, 0);
    const hourKey = hour.toISOString();
    const hourBucket = byHour.get(hourKey) ?? { requestCount: 0, estimatedCu: 0 };
    hourBucket.requestCount += event.pages;
    hourBucket.estimatedCu += event.estimatedCu;
    byHour.set(hourKey, hourBucket);
  }

  return {
    endpoints24h: [...byEndpoint.entries()].map(([endpoint, value]) => ({ endpoint, ...value })),
    externalKeys24h: [
      {
        externalApiKeyId: 'local-external-api-key',
        apiKeyName: 'Local external API key',
        requestCount: recent24h.reduce((sum, event) => sum + event.pages, 0),
        estimatedCu: recent24h.reduce((sum, event) => sum + event.estimatedCu, 0),
        lastSeenAt: recent24h.at(-1)?.timestamp ?? null,
      },
    ],
    hourly24h: [...byHour.entries()]
      .map(([hour, value]) => ({ hour, ...value }))
      .sort((left, right) => left.hour.localeCompare(right.hour)),
    recent: events.slice(-100).reverse().map((event) => ({
      createdAt: event.timestamp,
      endpoint: event.endpoint,
      externalApiKeyId: 'local-external-api-key',
      chain: event.chain,
      pairAddress: event.pairAddress,
      timeframe: event.timeframe,
      httpStatus: 200,
      estimatedCu: event.estimatedCu,
      pages: event.pages,
      durationMs: null,
    })),
  };
}

function getLocalCacheInventory(limit: number) {
  return [...candles.entries()]
    .map(([key, values]) => {
      const [chain, pairAddress, timeframe, currency] = key.split(':');
      const sorted = [...values].sort((left, right) => left.time - right.time);

      return {
        chain: chain ?? '',
        pairAddress: pairAddress ?? '',
        timeframe: timeframe ?? '',
        currency: currency ?? 'usd',
        candleCount: values.length,
        firstCandleAt: sorted[0]?.timestamp ?? null,
        lastCandleAt: sorted.at(-1)?.timestamp ?? null,
        updatedAt: sorted.at(-1)?.timestamp ?? null,
      };
    })
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .slice(0, limit);
}

function getAdminCacheInventory(limit: number) {
  const normalizedLimit = Math.max(1, Math.min(500, limit));
  const localInventory = getLocalCacheInventory(normalizedLimit);

  if (!persistentCacheSnapshotLoaded || persistentCacheInventorySnapshot.length === 0) {
    return localInventory;
  }

  const merged = new Map<string, {
    chain: string;
    pairAddress: string;
    timeframe: string;
    currency: string;
    candleCount: number;
    firstCandleAt: string | null;
    lastCandleAt: string | null;
    updatedAt: string | null;
  }>();

  for (const market of persistentCacheInventorySnapshot) {
    const key = [market.chain, market.pairAddress, market.timeframe, market.currency].join(':');
    merged.set(key, market);
  }

  for (const market of localInventory) {
    const key = [market.chain, market.pairAddress, market.timeframe, market.currency].join(':');
    merged.set(key, market);
  }

  return [...merged.values()]
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .slice(0, normalizedLimit);
}

function buildKey(params: {
  chain: string;
  pairAddress: string;
  timeframe: string;
  currency: string;
  from: Date;
  to: Date;
}) {
  return [
    params.chain,
    params.pairAddress,
    params.timeframe,
    params.currency,
    params.from.toISOString(),
    params.to.toISOString(),
  ].join(':');
}

function buildCandleKey(params: {
  chain: string;
  pairAddress: string;
  timeframe: string;
  currency: string;
}) {
  return [params.chain, params.pairAddress, params.timeframe, params.currency].join(':');
}

function buildHistoryStateKey(params: {
  chain: string;
  pairAddress: string;
  timeframe: string;
  currency: string;
}) {
  return ['history', params.chain, params.pairAddress, params.timeframe, params.currency].join(':');
}

function buildProviderFetchKey(params: {
  chain: string;
  pairAddress: string;
  currency: string;
}) {
  return [params.chain, params.pairAddress, params.currency].join(':');
}

async function loadPersistentCacheInventory(limit: number) {
  const pool = new Pool({ connectionString: config.DATABASE_URL });

  try {
    const result = await pool.query<{
      chain: string;
      pair_address: string;
      timeframe: string;
      currency: string;
      candle_count: string;
      first_candle_at: Date | null;
      last_candle_at: Date | null;
      updated_at: Date | null;
    }>(
      `
      SELECT
        chain,
        pair_address,
        timeframe,
        currency,
        count(*)::text AS candle_count,
        min(timestamp) AS first_candle_at,
        max(timestamp) AS last_candle_at,
        max(updated_at) AS updated_at
      FROM ohlcv_candles
      GROUP BY chain, pair_address, timeframe, currency
      ORDER BY max(updated_at) DESC
      LIMIT $1
      `,
      [Math.max(1, Math.min(500, limit))]
    );

    return result.rows.map((row) => ({
      chain: row.chain,
      pairAddress: row.pair_address,
      timeframe: row.timeframe,
      currency: row.currency,
      candleCount: Number(row.candle_count),
      firstCandleAt: row.first_candle_at?.toISOString() ?? null,
      lastCandleAt: row.last_candle_at?.toISOString() ?? null,
      updatedAt: row.updated_at?.toISOString() ?? null,
    }));
  } catch (error) {
    logger.error({ error }, 'Failed to load persistent cache inventory');
    throw new Error('Could not read persistent cache from Postgres. Check DATABASE_URL and migrations.');
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function buildCurrentLocalExportSnapshot() {
  const localSnapshot = buildLocalMemoryCacheSnapshot();

  if (persistentCacheSnapshotLoaded || localSnapshot.markets.length === 0) {
    try {
      const persistentSnapshot = await loadPersistentCacheSnapshot();

      if (persistentSnapshot.markets.length > 0) {
        return persistentSnapshot;
      }
    } catch (error) {
      logger.warn({ error }, 'Persistent cache snapshot export unavailable; falling back to local memory cache');
    }
  }

  return localSnapshot;
}

function buildLocalMemoryCacheSnapshot(): CacheSnapshot {
  const markets: CacheSnapshot['markets'] = [];

  for (const [key, values] of candles.entries()) {
    const [chain, pairAddress, timeframe, currency] = key.split(':');

    if (
      !chain ||
      !pairAddress ||
      !timeframe ||
      !isOhlcvTimeframe(timeframe) ||
      (currency !== 'usd' && currency !== 'native')
    ) {
      continue;
    }

    markets.push({
      chain,
      pairAddress,
      timeframe,
      currency,
      candles: [...values]
        .sort((left, right) => left.time - right.time)
        .map((candle) => ({
          timestamp: candle.timestamp,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          ...(candle.volume !== null ? { volume: candle.volume } : {}),
          ...(candle.trades !== null ? { trades: candle.trades } : {}),
        })),
    });
  }

  return {
    format: CACHE_SNAPSHOT_FORMAT,
    exportedAt: new Date().toISOString(),
    sourceRuntimeMode: persistentCacheSnapshotLoaded ? 'persistent-snapshot+local-memory' : 'local-memory',
    markets,
  };
}

async function loadPersistentCacheSnapshot(): Promise<CacheSnapshot> {
  const pool = new Pool({ connectionString: config.DATABASE_URL });

  try {
    const result = await pool.query<{
      chain: string;
      pair_address: string;
      timeframe: OhlcvTimeframe;
      currency: OhlcvCurrency;
      timestamp: Date;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string | null;
      trades: number | null;
    }>(
      `
      SELECT
        chain,
        pair_address,
        timeframe,
        currency,
        timestamp,
        open,
        high,
        low,
        close,
        volume,
        trades
      FROM ohlcv_candles
      ORDER BY chain, pair_address, timeframe, currency, timestamp ASC
      `
    );

    const markets = new Map<string, CacheSnapshot['markets'][number]>();

    for (const row of result.rows) {
      const key = [row.chain, row.pair_address, row.timeframe, row.currency].join(':');
      const market =
        markets.get(key) ??
        {
          chain: row.chain,
          pairAddress: row.pair_address,
          timeframe: row.timeframe,
          currency: row.currency,
          candles: [],
        };

      market.candles.push({
        timestamp: row.timestamp.toISOString(),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        ...(row.volume !== null ? { volume: Number(row.volume) } : {}),
        ...(row.trades !== null ? { trades: row.trades } : {}),
      });
      markets.set(key, market);
    }

    return {
      format: CACHE_SNAPSHOT_FORMAT,
      exportedAt: new Date().toISOString(),
      sourceRuntimeMode: 'persistent-snapshot',
      markets: [...markets.values()],
    };
  } finally {
    await pool.end().catch(() => undefined);
  }
}

function importSnapshotToLocalMemory(snapshot: CacheSnapshot) {
  let importedCandles = 0;

  for (const market of snapshot.markets) {
    const candleKey = buildCandleKey({
      chain: market.chain,
      pairAddress: market.pairAddress,
      timeframe: market.timeframe,
      currency: market.currency,
    });
    const incoming = market.candles.map((candle) =>
      normalizeChartCandle({
        time: Math.floor(new Date(candle.timestamp).getTime() / 1000),
        timestamp: candle.timestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume ?? null,
        trades: candle.trades ?? null,
        source: 'cache',
      })
    );

    candles.set(candleKey, mergeCandles(candles.get(candleKey) ?? [], incoming));
    importedCandles += incoming.length;
  }

  persistentCacheSnapshotLoaded = false;
  persistentCacheInventorySnapshot = [];

  return {
    importedMarkets: snapshot.markets.length,
    importedCandles,
  };
}

function isLocalFullHistoryRangeRequest(params: {
  timeframe: OhlcvTimeframe;
  from: Date;
  to: Date;
}) {
  const timeframeMs = timeframeSeconds[params.timeframe] * 1000;
  const nearNowThreshold = Date.now() - timeframeMs * 2;
  return params.from.getTime() <= LOCAL_HISTORY_FLOOR.getTime() && params.to.getTime() >= nearNowThreshold;
}

function computeLocalHistoryProgressPct(timeframe: OhlcvTimeframe, latestTimestampIso: string) {
  const latestTs = new Date(latestTimestampIso).getTime();
  if (Number.isNaN(latestTs)) {
    return null;
  }

  const stepMs = timeframeSeconds[timeframe] * 1000;
  const nowCeiling = Date.now() - stepMs;
  const totalSpan = Math.max(1, nowCeiling - LOCAL_HISTORY_FLOOR.getTime());
  const coveredSpan = Math.max(0, Math.min(latestTs, nowCeiling) - LOCAL_HISTORY_FLOOR.getTime());
  const raw = (coveredSpan / totalSpan) * 100;

  return Math.max(0, Math.min(99, Math.floor(raw)));
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

function parseIsoDateOrNull(value: string | null) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function filterGapsFromMarketStart(
  gaps: Array<{ from: Date; to: Date }>,
  marketStart: Date | null
) {
  if (!marketStart) {
    return gaps;
  }

  return gaps
    .map((gap) => ({
      from: gap.from.getTime() < marketStart.getTime() ? marketStart : gap.from,
      to: gap.to,
    }))
    .filter((gap) => gap.to.getTime() > gap.from.getTime());
}

function markCachedResponseCandles(response: unknown) {
  if (
    typeof response !== 'object' ||
    response === null ||
    !('candles' in response) ||
    !Array.isArray(response.candles)
  ) {
    return response;
  }

  const source =
    'source' in response && typeof response.source === 'string'
      ? response.source
      : undefined;

  return {
    ...response,
    source: source === 'cache+moralis' ? 'cache' : source,
    candles: response.candles.map((candle) =>
      typeof candle === 'object' && candle !== null
        ? {
            ...candle,
            source: candle.source === 'demo' ? 'demo' : 'cache',
          }
        : candle
    ),
  };
}

function isPartialChartResponse(response: unknown) {
  return (
    typeof response === 'object' &&
    response !== null &&
    'partial' in response &&
    response.partial === true
  );
}

function filterCandles(allCandles: ChartCandle[], from: Date, to: Date) {
  const fromSeconds = Math.floor(from.getTime() / 1000);
  const toSeconds = Math.floor(to.getTime() / 1000);

  return allCandles
    .filter((candle) => candle.time >= fromSeconds && candle.time <= toSeconds)
    .sort((a, b) => a.time - b.time);
}

function mergeCandles(existing: ChartCandle[], incoming: ChartCandle[]) {
  const byTime = new Map<number, ChartCandle>();

  for (const candle of existing) {
    byTime.set(candle.time, candle);
  }

  for (const candle of incoming) {
    byTime.set(candle.time, candle);
  }

  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function fillMissingChartCandles(
  inputCandles: ChartCandle[],
  from: Date,
  to: Date,
  timeframe: OhlcvTimeframe,
  seedCandle?: ChartCandle | undefined
) {
  const candlesByTime = new Map(inputCandles.map((candle) => [candle.time, candle]));
  const stepSeconds = timeframeSeconds[timeframe];
  const fromSeconds = Math.floor(alignToCandleStart(from, timeframe).getTime() / 1000);
  const toSeconds = Math.floor(Math.min(to.getTime(), Date.now()) / 1000);
  const result: ChartCandle[] = [];
  let previousReal: ChartCandle | undefined = seedCandle;

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

function findFillSeedCandle(params: {
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  from: Date;
  sameTimeframeCandles: ChartCandle[];
}) {
  const fromSeconds = Math.floor(params.from.getTime() / 1000);
  const sameTimeframeSeed = findLatestCandleBefore(params.sameTimeframeCandles, fromSeconds);

  if (sameTimeframeSeed) {
    return sameTimeframeSeed;
  }

  const compatibleSeeds: ChartCandle[] = [];

  for (const timeframe of Object.keys(timeframeSeconds)) {
    if (!isOhlcvTimeframe(timeframe)) {
      continue;
    }

    const candleKey = buildCandleKey({
      chain: params.chain,
      pairAddress: params.pairAddress,
      timeframe,
      currency: params.currency,
    });
    const seed = findLatestCandleBefore(candles.get(candleKey) ?? [], fromSeconds);

    if (seed) {
      compatibleSeeds.push(seed);
    }
  }

  return compatibleSeeds.sort((left, right) => right.time - left.time)[0];
}

function findLatestCandleBefore(allCandles: ChartCandle[], beforeSeconds: number) {
  return allCandles
    .filter((candle) => candle.source !== 'filled' && candle.time < beforeSeconds)
    .sort((left, right) => right.time - left.time)[0];
}

function getFillSeedLookbackFrom(from: Date, timeframe: OhlcvTimeframe) {
  const stepMs = timeframeSeconds[timeframe] * 1000;
  const lookbackByTimeframe: Partial<Record<OhlcvTimeframe, number>> = {
    '1min': 24 * 60 * 60 * 1000,
    '5min': 3 * 24 * 60 * 60 * 1000,
    '10min': 7 * 24 * 60 * 60 * 1000,
    '30min': 14 * 24 * 60 * 60 * 1000,
    '1h': 30 * 24 * 60 * 60 * 1000,
    '4h': 90 * 24 * 60 * 60 * 1000,
    '6h': 90 * 24 * 60 * 60 * 1000,
    '12h': 180 * 24 * 60 * 60 * 1000,
    '1d': 365 * 24 * 60 * 60 * 1000,
  };
  const lookbackMs = Math.max(stepMs, lookbackByTimeframe[timeframe] ?? 30 * stepMs);

  return new Date(Math.max(LOCAL_HISTORY_FLOOR.getTime(), from.getTime() - lookbackMs));
}

function toChartCandle(candle: MoralisCandle): ChartCandle {
  const timestamp = new Date(candle.timestamp);

  return normalizeChartCandle({
    time: Math.floor(timestamp.getTime() / 1000),
    timestamp: timestamp.toISOString(),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume ?? null,
    trades: candle.trades ?? null,
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

function createSyntheticCandlesFromCache(
  existingCandles: ChartCandle[],
  from: Date,
  to: Date,
  timeframe: OhlcvTimeframe
): ChartCandle[] {
  const sortedExisting = [...existingCandles].sort((a, b) => a.time - b.time);
  const stepMs = timeframeSeconds[timeframe] * 1000;
  const fromMs = alignToCandleStart(from, timeframe).getTime();
  const toMs = to.getTime();
  const timestamps: number[] = [];

  for (let timestampMs = fromMs; timestampMs < toMs; timestampMs += stepMs) {
    timestamps.push(timestampMs);
  }

  if (timestamps.length === 0) {
    return [];
  }

  const firstSeconds = Math.floor(timestamps[0]! / 1000);
  const lastSeconds = Math.floor(timestamps.at(-1)! / 1000);
  const previousReal = [...sortedExisting].reverse().find((candle) => candle.time < firstSeconds);
  const nextReal = sortedExisting.find((candle) => candle.time > lastSeconds);

  if (!previousReal) {
    logger.info(
      {
        timeframe,
        from: from.toISOString(),
        to: to.toISOString(),
        nextReal: nextReal?.timestamp,
      },
      'Skipped synthetic candles before first real cached candle'
    );
    return [];
  }

  const fallbackPrice = previousReal.close;
  const startPrice = previousReal.close;
  const endPrice = nextReal?.open ?? previousReal.close;
  const averageVolume =
    average(sortedExisting.map((candle) => candle.volume ?? 0).filter((value) => value > 0)) ??
    previousReal?.volume ??
    nextReal?.volume ??
    1000;
  const candles: ChartCandle[] = [];
  let previousClose = startPrice;

  for (let index = 0; index < timestamps.length; index += 1) {
    const timestampMs = timestamps[index]!;
    const progress = (index + 1) / (timestamps.length + 1);
    const trend = startPrice + (endPrice - startPrice) * progress;
    const wave = Math.sin(index / 9) * 0.012 + Math.cos(index / 23) * 0.006;
    const open = previousClose;
    const close = Math.max(0.000000000001, trend * (1 + wave));
    const high = Math.max(open, close) * (1 + 0.01 + (index % 7) * 0.0008);
    const low = Math.max(0, Math.min(open, close) * (1 - 0.01 - (index % 5) * 0.0008));
    const volume = averageVolume * (0.45 + Math.abs(Math.sin(index / 5)) * 0.9);

    previousClose = close;
    candles.push({
      time: Math.floor(timestampMs / 1000),
      timestamp: new Date(timestampMs).toISOString(),
      open,
      high,
      low,
      close,
      volume,
      trades: Math.max(1, Math.round((previousReal?.trades ?? nextReal?.trades ?? 8) * 0.75)),
    });
  }

  logger.info(
    {
      timeframe,
      candles: candles.length,
      from: from.toISOString(),
      to: to.toISOString(),
      anchoredToCache: sortedExisting.length > 0,
      previousReal: previousReal?.timestamp,
      nextReal: nextReal?.timestamp,
    },
    'Generated cache-anchored synthetic candles for local UI mode'
  );

  return candles;
}

function average(values: number[]) {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function fetchMoralisOhlcvLocal(params: {
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  from: Date;
  to: Date;
  maxPages: number;
  interactionId?: string | undefined;
}) {
  const result: MoralisCandle[] = [];
  let cursor: string | undefined;
  let pages = 0;
  const startedAt = Date.now();

  moralisLogger.warn(
    {
      provider: 'moralis',
      event: 'MORALIS_OHLCV_LOCAL_START',
      mode: 'local-memory',
      chain: params.chain,
      pairAddress: params.pairAddress,
      timeframe: params.timeframe,
      currency: params.currency,
      from: params.from.toISOString(),
      to: params.to.toISOString(),
      maxPages: params.maxPages,
      estimatedMaxCu: params.maxPages * MORALIS_OHLC_CU_COST,
    },
    'MORALIS_OHLCV_LOCAL_START'
  );
  await appendInteractionTraceEvent(params.interactionId, 'moralis_local_start', {
    chain: params.chain,
    pairAddress: params.pairAddress,
    timeframe: params.timeframe,
    currency: params.currency,
    from: params.from.toISOString(),
    to: params.to.toISOString(),
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
    url.searchParams.set('fromDate', params.from.toISOString());
    url.searchParams.set('toDate', params.to.toISOString());
    url.searchParams.set('limit', '1000');

    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }

    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'X-API-Key': config.MORALIS_API_KEY,
      },
    });

    if (!response.ok) {
      moralisLogger.error(
        {
          provider: 'moralis',
          event: 'MORALIS_OHLCV_LOCAL_PAGE_FAILED',
          mode: 'local-memory',
          chain: params.chain,
          pairAddress: params.pairAddress,
          timeframe: params.timeframe,
          currency: params.currency,
          from: params.from.toISOString(),
          to: params.to.toISOString(),
          page: pages + 1,
          status: response.status,
        },
        'MORALIS_OHLCV_LOCAL_PAGE_FAILED'
      );
      await appendInteractionTraceEvent(params.interactionId, 'moralis_local_page_failed', {
        chain: params.chain,
        pairAddress: params.pairAddress,
        timeframe: params.timeframe,
        currency: params.currency,
        from: params.from.toISOString(),
        to: params.to.toISOString(),
        page: pages + 1,
        status: response.status,
      });
      throw new Error(`Moralis local fetch failed: ${response.status} ${await response.text()}`);
    }

    const json = (await response.json()) as {
      cursor?: string | null;
      result?: MoralisCandle[];
    };

    const pageCandles = json.result ?? [];
    result.push(...pageCandles);
    cursor = json.cursor ?? undefined;
    pages += 1;

    moralisLogger.warn(
      {
        provider: 'moralis',
        event: 'MORALIS_OHLCV_LOCAL_PAGE_OK',
        mode: 'local-memory',
        chain: params.chain,
        pairAddress: params.pairAddress,
        timeframe: params.timeframe,
        currency: params.currency,
        from: params.from.toISOString(),
        to: params.to.toISOString(),
        page: pages,
        pageCandles: pageCandles.length,
        hasNextCursor: Boolean(cursor),
        estimatedCuSoFar: pages * MORALIS_OHLC_CU_COST,
      },
      'MORALIS_OHLCV_LOCAL_PAGE_OK'
    );
    await appendInteractionTraceEvent(params.interactionId, 'moralis_local_page_ok', {
      chain: params.chain,
      pairAddress: params.pairAddress,
      timeframe: params.timeframe,
      currency: params.currency,
      from: params.from.toISOString(),
      to: params.to.toISOString(),
      page: pages,
      pageCandles: pageCandles.length,
      hasNextCursor: Boolean(cursor),
      estimatedCuSoFar: pages * MORALIS_OHLC_CU_COST,
    });
  } while (cursor);

  moralisLogger.warn(
    {
      provider: 'moralis',
      event: 'MORALIS_OHLCV_LOCAL_DONE',
      mode: 'local-memory',
      chain: params.chain,
      pairAddress: params.pairAddress,
      timeframe: params.timeframe,
      currency: params.currency,
      from: params.from.toISOString(),
      to: params.to.toISOString(),
      pages,
      candles: result.length,
      estimatedCu: pages * MORALIS_OHLC_CU_COST,
      durationMs: Date.now() - startedAt,
      truncated: Boolean(cursor),
    },
    'MORALIS_OHLCV_LOCAL_DONE'
  );
  await appendInteractionTraceEvent(params.interactionId, 'moralis_local_done', {
    chain: params.chain,
    pairAddress: params.pairAddress,
    timeframe: params.timeframe,
    currency: params.currency,
    from: params.from.toISOString(),
    to: params.to.toISOString(),
    pages,
    candles: result.length,
    estimatedCu: pages * MORALIS_OHLC_CU_COST,
    durationMs: Date.now() - startedAt,
    truncated: Boolean(cursor),
  });

  return {
    candles: result,
    pages,
    truncated: Boolean(cursor),
  };
}

async function fetchRecentFallbackWindow(params: {
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  from: Date;
  to: Date;
}) {
  const fallbackFrom = new Date(Math.max(params.from.getTime(), params.to.getTime() - 30 * 24 * 60 * 60 * 1000));

  try {
    const result = await fetchMoralisOhlcvLocal({
      chain: params.chain,
      pairAddress: params.pairAddress,
      timeframe: params.timeframe,
      currency: params.currency,
      from: fallbackFrom,
      to: params.to,
      maxPages: 1,
    });

    logger.info(
      {
        provider: 'moralis',
        pairAddress: params.pairAddress,
        timeframe: params.timeframe,
        pages: result.pages,
        returnedCandles: result.candles.length,
        estimatedCu: result.pages * MORALIS_OHLC_CU_COST,
        from: fallbackFrom.toISOString(),
        to: params.to.toISOString(),
        mode: 'local-memory',
      },
      'Fetched recent Moralis anchor after full-range request failed'
    );

    return {
      ...result,
      from: fallbackFrom,
      to: params.to,
    };
  } catch (error) {
    logger.error(
      {
        error,
        pairAddress: params.pairAddress,
        chain: params.chain,
        timeframe: params.timeframe,
        from: fallbackFrom.toISOString(),
        to: params.to.toISOString(),
      },
      'Recent Moralis anchor fetch failed'
    );

    return {
      candles: [],
      pages: 0,
      from: fallbackFrom,
      to: params.to,
    };
  }
}

function buildMoralisOhlcvUrl(chain: string, pairAddress: string) {
  if (chain === 'solana') {
    return new URL(`https://solana-gateway.moralis.io/token/mainnet/pairs/${pairAddress}/ohlcv`);
  }

  return new URL(`https://deep-index.moralis.io/api/v2.2/pairs/${pairAddress}/ohlcv`);
}

async function recordMoralisUsage(params: {
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  requestFrom: Date;
  requestTo: Date;
  pages: number;
  returnedCandles: number;
}) {
  resetLocalUsageDayIfNeeded();

  const estimatedCu = params.pages * MORALIS_OHLC_CU_COST;
  const timestamp = new Date().toISOString();
  const event: LocalProxyUsageEvent = {
    timestamp,
    provider: 'moralis',
    endpoint: 'getPairCandlesticks',
    chain: params.chain,
    pairAddress: params.pairAddress,
    timeframe: params.timeframe,
    currency: params.currency,
    requestFrom: params.requestFrom.toISOString(),
    requestTo: params.requestTo.toISOString(),
    pages: params.pages,
    estimatedCu,
    returnedCandles: params.returnedCandles,
    mode: 'local-memory',
  };

  usage.todayCu += estimatedCu;
  usage.totalCu += estimatedCu;
  usage.todayRequests += params.pages;
  usage.totalRequests += params.pages;
  usage.updatedAt = timestamp;

  await persistLocalProxyUsage(event);
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

async function loadLocalProxyUsage(): Promise<LocalProxyUsage> {
  const emptyUsage = createEmptyLocalProxyUsage();

  try {
    const raw = await fs.readFile(LOCAL_PROXY_USAGE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LocalProxyUsage>;
    const loaded: LocalProxyUsage = {
      todayCu: Number(parsed.todayCu ?? 0),
      totalCu: Number(parsed.totalCu ?? 0),
      todayRequests: Number(parsed.todayRequests ?? 0),
      totalRequests: Number(parsed.totalRequests ?? 0),
      since: typeof parsed.since === 'string' ? parsed.since : emptyUsage.since,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : emptyUsage.updatedAt,
      storage: emptyUsage.storage,
    };

    resetLoadedUsageDayIfNeeded(loaded);
    return loaded;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      await writeLocalProxyUsageSummary(emptyUsage);
      return emptyUsage;
    }

    logger.warn(
      { error, file: LOCAL_PROXY_USAGE_FILE },
      'Could not read local proxy usage file. Starting counters from zero.'
    );
    return emptyUsage;
  }
}

function createEmptyLocalProxyUsage(): LocalProxyUsage {
  const now = new Date();
  return {
    todayCu: 0,
    totalCu: 0,
    todayRequests: 0,
    totalRequests: 0,
    since: startOfUtcDay(now).toISOString(),
    updatedAt: now.toISOString(),
    storage: {
      summaryFile: LOCAL_PROXY_USAGE_FILE,
      eventsFile: LOCAL_PROXY_USAGE_EVENTS_FILE,
    },
  };
}

function resetLocalUsageDayIfNeeded() {
  resetLoadedUsageDayIfNeeded(usage);
}

function resetLoadedUsageDayIfNeeded(target: LocalProxyUsage) {
  const todayStart = startOfUtcDay(new Date()).toISOString();

  if (target.since !== todayStart) {
    target.todayCu = 0;
    target.todayRequests = 0;
    target.since = todayStart;
  }
}

async function persistLocalProxyUsage(event: LocalProxyUsageEvent) {
  await fs.appendFile(LOCAL_PROXY_USAGE_EVENTS_FILE, `${JSON.stringify(event)}\n`, 'utf8');
  await writeLocalProxyUsageSummary(usage);
}

async function recordLocalThrottleEvent(params: {
  reason: LocalThrottleEvent['reason'];
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  requestFrom: Date;
  requestTo: Date;
  detailMs: number | null;
}) {
  const event: LocalThrottleEvent = {
    timestamp: new Date().toISOString(),
    reason: params.reason,
    chain: params.chain,
    pairAddress: params.pairAddress,
    timeframe: params.timeframe,
    currency: params.currency,
    requestFrom: params.requestFrom.toISOString(),
    requestTo: params.requestTo.toISOString(),
    detailMs: params.detailMs,
    mode: 'local-memory',
  };

  try {
    await fs.appendFile(LOCAL_THROTTLE_EVENTS_FILE, `${JSON.stringify(event)}\n`, 'utf8');
  } catch (error) {
    logger.warn(
      {
        error,
        file: LOCAL_THROTTLE_EVENTS_FILE,
        reason: event.reason,
      },
      'Failed to persist local throttle event.'
    );
  }
}

async function readLocalThrottleEvents(limit: number) {
  try {
    const raw = await fs.readFile(LOCAL_THROTTLE_EVENTS_FILE, 'utf8');
    const rows = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as LocalThrottleEvent;
        } catch {
          return null;
        }
      })
      .filter((event): event is LocalThrottleEvent => event !== null);

    return rows.slice(-limit).reverse();
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }

    logger.warn(
      {
        error,
        file: LOCAL_THROTTLE_EVENTS_FILE,
      },
      'Failed to read local throttle events.'
    );
    return [];
  }
}

async function readLocalUsageEvents(limit: number) {
  try {
    const raw = await fs.readFile(LOCAL_PROXY_USAGE_EVENTS_FILE, 'utf8');
    const rows = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as LocalProxyUsageEvent;
        } catch {
          return null;
        }
      })
      .filter((event): event is LocalProxyUsageEvent => event !== null);

    return rows.slice(-limit);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }

    logger.warn(
      {
        error,
        file: LOCAL_PROXY_USAGE_EVENTS_FILE,
      },
      'Failed to read local usage events.'
    );
    return [];
  }
}

async function writeLocalProxyUsageSummary(summary: LocalProxyUsage) {
  const tmpFile = `${LOCAL_PROXY_USAGE_FILE}.tmp`;
  await fs.writeFile(tmpFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await fs.rename(tmpFile, LOCAL_PROXY_USAGE_FILE);
}

function toMoralisCompatCandle(candle: ChartCandle) {
  const result: {
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
    trades?: number;
  } = {
    timestamp: candle.timestamp,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  };

  if (candle.volume !== null) {
    result.volume = candle.volume;
  }

  if (candle.trades !== null) {
    result.trades = candle.trades;
  }

  return result;
}

function isLocalExternalApiKeyAllowed(apiKey: string | undefined) {
  return Boolean(apiKey) && apiKey === localExternalApiKey;
}

function encodeCursor(cursor: MoralisCompatCursor) {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined) {
  if (!cursor) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8')
    ) as MoralisCompatCursor;

    if (
      typeof parsed.beforeDate !== 'string' ||
      Number.isNaN(new Date(parsed.beforeDate).getTime()) ||
      typeof parsed.effectiveTimeframe !== 'string' ||
      !isOhlcvTimeframe(parsed.effectiveTimeframe)
    ) {
      throw new Error('Invalid cursor beforeDate');
    }

    return parsed;
  } catch {
    throw new Error('Invalid cursor');
  }
}

async function ensureLocalExternalApiKey() {
  try {
    const existing = (await fs.readFile(LOCAL_EXTERNAL_API_KEY_FILE, 'utf8')).trim();

    if (existing) {
      return existing;
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }

  const apiKey = `mcs_live_local_${crypto.randomBytes(24).toString('base64url')}`;
  await fs.writeFile(LOCAL_EXTERNAL_API_KEY_FILE, `${apiKey}\n`, { encoding: 'utf8', mode: 0o600 });
  return apiKey;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
