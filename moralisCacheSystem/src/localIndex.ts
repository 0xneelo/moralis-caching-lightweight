import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { z } from 'zod';
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
const LOCAL_PROVIDER_FETCH_COOLDOWN_MS = 60_000;
const LOCAL_EXTERNAL_API_KEY_FILE = '.local-external-api-key';
const LOCAL_PROXY_USAGE_FILE = '.local-proxy-usage.json';
const LOCAL_PROXY_USAGE_EVENTS_FILE = '.local-proxy-usage.jsonl';
const candles = new Map<string, ChartCandle[]>();
const responses = new Map<string, unknown>();
const activeProviderFetches = new Set<string>();
const providerFetchCooldowns = new Map<string, number>();

type MoralisCompatCursor = {
  fromDate: string;
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

const usage = await loadLocalProxyUsage();

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
});

const localExternalApiKey = await ensureLocalExternalApiKey();

const app = Fastify({
  loggerInstance: logger,
  trustProxy: true,
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

  const pairAddress = normalizePairAddress(parsed.data.chain, parsed.data.pairAddress);
  const from = new Date(parsed.data.from);
  const to = new Date(parsed.data.to);
  const visibleFrom = parsed.data.visibleFrom ? new Date(parsed.data.visibleFrom) : from;
  const visibleTo = parsed.data.visibleTo ? new Date(parsed.data.visibleTo) : to;
  const requestedTimeframe = parsed.data.requestedTimeframe ?? parsed.data.timeframe;
  const interactionId = request.headers['x-interaction-id']?.toString();
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

  if (cachedResponse && !isPartialChartResponse(cachedResponse)) {
    await appendInteractionTraceEvent(interactionId, 'cache_response_hit', {
      route: '/api/charts/ohlcv',
      chain: parsed.data.chain,
      pairAddress,
      requestedTimeframe,
      effectiveTimeframe,
      from: from.toISOString(),
      to: to.toISOString(),
      cacheKey: responseKey,
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
    return cacheDebugResponse;
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
  const gaps = findMissingRanges({
    candles: matching.map((candle) => ({ timestamp: new Date(candle.timestamp) })),
    timeframe: effectiveTimeframe,
    from,
    to,
  });
  const prioritizedGaps = prioritizeVisibleGaps(gaps, {
    from: visibleFrom,
    to: visibleTo,
  });
  const moralisCandleTimes = new Set<number>();
  let generatedDemoCandles = false;
  let responseSource: 'cache' | 'cache+moralis' | 'partial' | 'demo' =
    gaps.length === 0 ? 'cache' : 'partial';
  let partial = gaps.length > 0;

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
          partial = true;
          break;
        }

        const lastProviderFetchAt = providerFetchCooldowns.get(providerFetchKey) ?? 0;
        const cooldownRemainingMs =
          LOCAL_PROVIDER_FETCH_COOLDOWN_MS - (Date.now() - lastProviderFetchAt);

        if (cooldownRemainingMs > 0) {
          logger.warn(
            {
              pairAddress,
              requestedTimeframe,
              effectiveTimeframe,
              cooldownRemainingMs,
              gapFrom: gap.from.toISOString(),
              gapTo: gap.to.toISOString(),
            },
            'Skipped local Moralis fetch because provider fetch cooldown is active for this pair'
          );
          partial = true;
          break;
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
            stored = mergeCandles(stored, fetchedCandles);
            const remainingGaps = findMissingRanges({
              candles: filterCandles(stored, gap.from, gap.to).map((candle) => ({
                timestamp: new Date(candle.timestamp),
              })),
              timeframe: effectiveTimeframe,
              from: gap.from,
              to: gap.to,
            });

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

  const finalCandles = fillMissingChartCandles(
    filterCandles(candles.get(candleKey) ?? [], from, to).map((candle) => ({
      ...candle,
      source: generatedDemoCandles
        ? 'demo'
        : moralisCandleTimes.has(candle.time)
          ? 'moralis'
          : 'cache',
    })),
    from,
    to,
    effectiveTimeframe
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
    candles: finalCandles,
  };

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

  return injectMoralisCompatOhlcv({
    reply,
    chain: parsedQuery.data.chain ?? 'eth',
    pairAddress: parsedParams.data.pairAddress,
    timeframe: parsedQuery.data.timeframe,
    currency: parsedQuery.data.currency,
    fromDate: parsedQuery.data.fromDate,
    toDate: parsedQuery.data.toDate,
    requestedLimit: parsedQuery.data.limit,
    cursor: parsedQuery.data.cursor,
  });
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
  const effectiveTimeframe = getEffectiveAdaptiveTimeframe({
    requestedTimeframe: params.timeframe,
    from: requestedFrom,
    to: requestedTo,
  });
  const effectiveLimit = clampMoralisCompatLimit(params.requestedLimit);
  let pageWindow: ReturnType<typeof getPageWindow>;

  try {
    pageWindow = getPageWindow({
      cursor: params.cursor,
      fromDate: params.fromDate,
      toDate: params.toDate,
      timeframe: effectiveTimeframe,
      limit: effectiveLimit,
    });
  } catch (error) {
    return params.reply.status(400).send({
      error: error instanceof Error ? error.message : 'Invalid request',
    });
  }

  if (!pageWindow) {
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
  const chartQuery = new URLSearchParams({
    chain: params.chain,
    pairAddress: params.pairAddress,
    timeframe: effectiveTimeframe,
    requestedTimeframe: params.timeframe,
    currency: params.currency,
    from: pageWindow.from.toISOString(),
    to: pageWindow.to.toISOString(),
  });
  const chartResponse = await app.inject({
    method: 'GET',
    url: `/api/charts/ohlcv?${chartQuery.toString()}`,
  });

  if (chartResponse.statusCode !== 200) {
    params.reply.status(chartResponse.statusCode);
    return chartResponse.json();
  }

  const body = chartResponse.json<{ source: string; candles: ChartCandle[] }>();
  const result = body.candles.slice(0, effectiveLimit).map(toMoralisCompatCandle);
  const cuDelta = usage.totalCu - beforeCu;
  const cursor =
    pageWindow.nextFrom && pageWindow.nextFrom < pageWindow.requestedTo
      ? encodeCursor({
          fromDate: pageWindow.nextFrom.toISOString(),
          effectiveTimeframe,
        })
      : null;

  setMoralisCompatHeaders(params.reply, {
    source: body.source,
    cuUsed: cuDelta,
    requestedTimeframe: params.timeframe,
    effectiveTimeframe,
    effectiveLimit,
    pageFrom: pageWindow.from,
    pageTo: pageWindow.to,
  });

  logger.info(
    {
      compatibility: 'moralis',
      chain: params.chain,
      pairAddress: params.pairAddress,
      requestedTimeframe: params.timeframe,
      effectiveTimeframe,
      source: body.source,
      returnedCandles: result.length,
      estimatedCu: cuDelta,
      nextCursor: Boolean(cursor),
      from: pageWindow.from.toISOString(),
      to: pageWindow.to.toISOString(),
    },
    'Served Moralis-compatible OHLCV request'
  );

  return {
    cursor,
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

function buildProviderFetchKey(params: {
  chain: string;
  pairAddress: string;
  currency: string;
}) {
  return [params.chain, params.pairAddress, params.currency].join(':');
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

function toChartCandle(candle: MoralisCandle): ChartCandle {
  const timestamp = new Date(candle.timestamp);

  return {
    time: Math.floor(timestamp.getTime() / 1000),
    timestamp: timestamp.toISOString(),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume ?? null,
    trades: candle.trades ?? null,
  };
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

function getPageWindow(params: {
  cursor?: string | undefined;
  fromDate: string;
  toDate: string;
  timeframe: OhlcvTimeframe;
  limit: number;
}) {
  const requestedFrom = new Date(params.fromDate);
  const requestedTo = new Date(params.toDate);
  const cursor = decodeCursor(params.cursor);

  if (cursor && cursor.effectiveTimeframe !== params.timeframe) {
    throw new Error('Invalid cursor');
  }

  const from = cursor ? new Date(cursor.fromDate) : requestedFrom;

  if (requestedTo <= requestedFrom) {
    throw new Error('Invalid chart range');
  }

  if (from >= requestedTo) {
    return null;
  }

  const stepMs = timeframeSeconds[params.timeframe] * 1000;
  const nextFrom = new Date(from.getTime() + params.limit * stepMs);
  const pageTo = new Date(Math.min(requestedTo.getTime(), nextFrom.getTime()));

  return {
    from,
    to: pageTo,
    requestedTo,
    nextFrom,
  };
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
      typeof parsed.fromDate !== 'string' ||
      Number.isNaN(new Date(parsed.fromDate).getTime()) ||
      typeof parsed.effectiveTimeframe !== 'string' ||
      !isOhlcvTimeframe(parsed.effectiveTimeframe)
    ) {
      throw new Error('Invalid cursor fromDate');
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
