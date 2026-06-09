import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authenticateExternalApiKey } from '../auth/externalApiKeyAuth.js';
import { getChartCacheTtl, getJsonCache, setJsonCache } from '../cache.js';
import { config } from '../config.js';
import { badRequest } from '../httpErrors.js';
import { enqueueBackfillJob } from '../jobs/enqueue.js';
import { fetchMoralisOhlcv } from '../moralis.js';
import { normalizePairAddress } from '../pairAddress.js';
import { enforceExternalApiKeyRequestRateLimit } from '../rateLimit.js';
import { candleRepository } from '../repositories/candles.js';
import { providerUsageRepository } from '../repositories/providerUsage.js';
import {
  isOhlcvTimeframe,
  maxSyncCandlesByTimeframe,
  timeframeSeconds,
} from '../timeframes.js';
import type { ChartCandle, OhlcvCurrency, OhlcvTimeframe, StoredCandle } from '../types.js';

type MoralisOhlcvCandle = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  trades?: number;
};

type MoralisOhlcvResponse = {
  cursor: string | null;
  result: MoralisOhlcvCandle[];
};

type TokenOhlcResponse = {
  s: 'ok' | 'no_data';
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
  result: MoralisOhlcvCandle[];
};

type MoralisCompatResult = {
  body: MoralisOhlcvResponse;
  headers: Record<string, string>;
};

type TokenOhlcResult = {
  body: TokenOhlcResponse;
  headers: Record<string, string>;
};

type MoralisCompatCursor = {
  beforeDate: string;
  effectiveTimeframe: OhlcvTimeframe;
};

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;

const moralisOhlcvQuerySchema = z.object({
  chain: z.string().min(1).optional(),
  timeframe: z.custom<OhlcvTimeframe>((value) => typeof value === 'string' && isOhlcvTimeframe(value), {
    message: 'Unsupported timeframe',
  }),
  currency: z.enum(['usd', 'native']).optional(),
  fromDate: z.string().datetime(),
  toDate: z.string().datetime(),
  limit: z.coerce.number().int().optional(),
  cursor: z.string().min(1).optional(),
});

const tokenOhlcQuerySchema = z.object({
  pairAddress: z.string().min(1),
  chainId: z.string().min(1),
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
  resolution: z.string().min(1),
  limit: z.coerce.number().int().positive().optional(),
});

const tokenOhlcCountbackQuerySchema = z.object({
  pairAddress: z.string().min(1),
  chainId: z.string().min(1),
  to: z.coerce.number().int().positive(),
  resolution: z.string().min(1),
  countBack: z.coerce.number().int().positive(),
  currency: z.enum(['usd', 'native']).optional(),
});

export async function registerMoralisCompatRoutes(app: FastifyInstance) {
  app.get('/api/token/ohlc/countback', async (request, reply) => {
    const apiKey = await authenticateExternalApiKey(request);
    await enforceExternalApiKeyRequestRateLimit({ apiKeyId: apiKey.id });
    const parsed = tokenOhlcCountbackQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    reply.header('Cache-Control', 'private, max-age=5');

    const result = await getTokenOhlcCountbackResponse({
      chain: normalizeChainId(parsed.data.chainId),
      pairAddress: parsed.data.pairAddress,
      timeframe: mapResolutionToTimeframe(parsed.data.resolution),
      currency: (parsed.data.currency ?? config.DEFAULT_CURRENCY) as OhlcvCurrency,
      to: new Date(parsed.data.to * 1000),
      countBack: parsed.data.countBack,
    });

    setCompatibilityHeaders(reply, result.headers);
    return result.body;
  });

  app.get('/api/token/ohlc', async (request, reply) => {
    const apiKey = await authenticateExternalApiKey(request);
    await enforceExternalApiKeyRequestRateLimit({ apiKeyId: apiKey.id });
    const parsed = tokenOhlcQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    reply.header('Cache-Control', 'private, max-age=5');

    const result = await getTokenOhlcResponse({
      chain: normalizeChainId(parsed.data.chainId),
      pairAddress: parsed.data.pairAddress,
      timeframe: mapResolutionToTimeframe(parsed.data.resolution),
      currency: config.DEFAULT_CURRENCY as OhlcvCurrency,
      from: new Date(parsed.data.from * 1000),
      to: new Date(parsed.data.to * 1000),
      limit: parsed.data.limit,
    });

    setCompatibilityHeaders(reply, result.headers);
    return result.body;
  });

  app.get('/api/v2.2/pairs/:pairAddress/ohlcv', async (request, reply) => {
    const apiKey = await authenticateExternalApiKey(request);
    await enforceExternalApiKeyRequestRateLimit({ apiKeyId: apiKey.id });
    const pairAddress = getPairAddress(request.params);
    const parsed = moralisOhlcvQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    reply.header('Cache-Control', 'private, max-age=5');

    const result = await getMoralisOhlcvResponse({
      chain: normalizeChainId(parsed.data.chain ?? 'eth'),
      pairAddress,
      timeframe: parsed.data.timeframe,
      currency: (parsed.data.currency ?? config.DEFAULT_CURRENCY) as OhlcvCurrency,
      fromDate: parsed.data.fromDate,
      toDate: parsed.data.toDate,
      requestedLimit: parsed.data.limit,
      cursor: parsed.data.cursor,
      externalApiKeyId: apiKey.id,
      userId: `api-key:${apiKey.id}`,
      ip: request.ip,
    });

    setCompatibilityHeaders(reply, result.headers);
    return result.body;
  });

  app.get('/token/mainnet/pairs/:pairAddress/ohlcv', async (request, reply) => {
    const apiKey = await authenticateExternalApiKey(request);
    await enforceExternalApiKeyRequestRateLimit({ apiKeyId: apiKey.id });
    const pairAddress = getPairAddress(request.params);
    const parsed = moralisOhlcvQuerySchema.omit({ chain: true }).safeParse(request.query);

    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    reply.header('Cache-Control', 'private, max-age=5');

    const result = await getMoralisOhlcvResponse({
      chain: 'solana',
      pairAddress,
      timeframe: parsed.data.timeframe,
      currency: (parsed.data.currency ?? config.DEFAULT_CURRENCY) as OhlcvCurrency,
      fromDate: parsed.data.fromDate,
      toDate: parsed.data.toDate,
      requestedLimit: parsed.data.limit,
      cursor: parsed.data.cursor,
      externalApiKeyId: apiKey.id,
      userId: `api-key:${apiKey.id}`,
      ip: request.ip,
    });

    setCompatibilityHeaders(reply, result.headers);
    return result.body;
  });
}

async function getTokenOhlcResponse(params: {
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  from: Date;
  to: Date;
  limit?: number | undefined;
}): Promise<TokenOhlcResult> {
  if (params.to <= params.from) {
    throw badRequest('Invalid chart range');
  }

  const effectiveLimit = clampLimit(params.timeframe, params.limit);
  const pairAddress = normalizePairAddress(params.chain, params.pairAddress);
  const cacheKey = buildTokenOhlcCacheKey({
    ...params,
    pairAddress,
    limit: effectiveLimit,
  });
  const cachedResponse = await getJsonCache<TokenOhlcResult>(cacheKey);

  if (cachedResponse) {
    return cachedResponse;
  }

  const storedCandles = await candleRepository.findCandles({
    chain: params.chain,
    pairAddress,
    timeframe: params.timeframe,
    currency: params.currency,
    from: params.from,
    to: params.to,
  });
  warmExternalCacheInBackground({
    chain: params.chain,
    pairAddress,
    timeframe: params.timeframe,
    currency: params.currency,
    from: params.from,
    to: params.to,
    cachedCandles: storedCandles.length,
  });

  const selectedCandles = storedCandles.slice(-effectiveLimit);
  const result = selectedCandles.map(toMoralisCandle);
  const response = {
    body: toTokenOhlcBody(selectedCandles, result),
    headers: buildCompatibilityHeaders({
      source: result.length > 0 ? 'cache' : 'partial',
      cuUsed: 0,
      requestedTimeframe: params.timeframe,
      effectiveTimeframe: params.timeframe,
      effectiveLimit,
      pageFrom: params.from,
      pageTo: params.to,
    }),
  };

  await setJsonCache(cacheKey, response, getChartCacheTtl(params.timeframe));
  return response;
}

async function getTokenOhlcCountbackResponse(params: {
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  to: Date;
  countBack: number;
}): Promise<TokenOhlcResult> {
  const effectiveLimit = clampLimit(params.timeframe, params.countBack);
  const pairAddress = normalizePairAddress(params.chain, params.pairAddress);
  const cacheKey = buildTokenOhlcCountbackCacheKey({
    ...params,
    pairAddress,
    countBack: effectiveLimit,
  });
  const cachedResponse = await getJsonCache<TokenOhlcResult>(cacheKey);

  if (cachedResponse) {
    return cachedResponse;
  }

  const storedCandles = await candleRepository.findCountbackCandles({
    chain: params.chain,
    pairAddress,
    timeframe: params.timeframe,
    currency: params.currency,
    to: params.to,
    countBack: effectiveLimit,
  });

  if (storedCandles.length < effectiveLimit) {
    const warmFrom = getCountbackWarmFrom(params.to, params.timeframe, effectiveLimit);
    warmExternalCacheInBackground({
      chain: params.chain,
      pairAddress,
      timeframe: params.timeframe,
      currency: params.currency,
      from: warmFrom,
      to: params.to,
      cachedCandles: storedCandles.length,
    });
  }

  const result = storedCandles.map(toMoralisCandle);
  const response = {
    body: toTokenOhlcBody(storedCandles, result),
    headers: {
      ...buildCompatibilityHeaders({
        source: storedCandles.length >= effectiveLimit ? 'cache' : 'partial',
        cuUsed: 0,
        requestedTimeframe: params.timeframe,
        effectiveTimeframe: params.timeframe,
        effectiveLimit,
        pageFrom: storedCandles[0]?.timestamp ?? null,
        pageTo: params.to,
      }),
      'x-countback-returned': String(storedCandles.length),
    },
  };

  await setJsonCache(cacheKey, response, getChartCacheTtl(params.timeframe));
  return response;
}

async function getMoralisOhlcvResponse(params: {
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  fromDate: string;
  toDate: string;
  requestedLimit?: number | undefined;
  cursor?: string | undefined;
  externalApiKeyId: string;
  userId: string;
  ip: string;
}): Promise<MoralisCompatResult> {
  const requestedFrom = new Date(params.fromDate);
  const requestedTo = new Date(params.toDate);

  if (requestedTo <= requestedFrom) {
    throw badRequest('Invalid chart range');
  }

  const effectiveTimeframe = params.timeframe;
  const effectiveLimit = clampLimit(effectiveTimeframe, params.requestedLimit);
  const cursor = decodeCursor(params.cursor);

  if (cursor && cursor.effectiveTimeframe !== effectiveTimeframe) {
    throw badRequest('Invalid cursor');
  }

  const pageBefore = cursor ? new Date(cursor.beforeDate) : requestedTo;

  if (pageBefore <= requestedFrom) {
    return {
      body: {
        cursor: null,
        result: [],
      },
      headers: buildCompatibilityHeaders({
        source: 'cache',
        cuUsed: 0,
        requestedTimeframe: params.timeframe,
        effectiveTimeframe,
        effectiveLimit,
        pageFrom: null,
        pageTo: null,
      }),
    };
  }

  const compatCacheKey = buildMoralisCompatCacheKey({
    chain: params.chain,
    pairAddress: params.pairAddress,
    requestedTimeframe: params.timeframe,
    effectiveTimeframe,
    currency: params.currency,
    from: requestedFrom,
    to: pageBefore,
    limit: effectiveLimit,
  });
  const cachedResponse = await getJsonCache<MoralisCompatResult>(compatCacheKey);
  if (cachedResponse) {
    return cachedResponse;
  }

  const pairAddress = normalizePairAddress(params.chain, params.pairAddress);
  let pageCandles = await candleRepository.findCandlesPageDesc({
    chain: params.chain,
    pairAddress,
    timeframe: effectiveTimeframe,
    currency: params.currency,
    from: requestedFrom,
    to: requestedTo,
    before: cursor ? pageBefore : undefined,
    limit: effectiveLimit + 1,
  });

  let source = 'cache';
  let cuUsed = 0;
  let providerTruncated = false;

  if (pageCandles.length <= effectiveLimit) {
    const providerResult = await fetchMoralisOhlcv({
      chain: params.chain,
      pairAddress,
      timeframe: effectiveTimeframe,
      currency: params.currency,
      fromDate: requestedFrom,
      toDate: pageBefore,
      maxPages: 1,
    });
    providerTruncated = providerResult.truncated;
    source = 'cache+moralis';
    cuUsed = providerResult.estimatedCu;

    await candleRepository.upsertCandles({
      chain: params.chain,
      pairAddress,
      timeframe: effectiveTimeframe,
      currency: params.currency,
      candles: providerResult.candles,
    });

    await providerUsageRepository.log({
      provider: 'moralis',
      endpoint: 'getPairCandlesticks',
      externalApiKeyId: params.externalApiKeyId,
      chain: params.chain,
      pairAddress,
      timeframe: effectiveTimeframe,
      requestFrom: requestedFrom,
      requestTo: pageBefore,
      httpStatus: 200,
      estimatedCu: providerResult.estimatedCu,
      pages: providerResult.pages,
      durationMs: providerResult.durationMs,
    });

    pageCandles = await candleRepository.findCandlesPageDesc({
      chain: params.chain,
      pairAddress,
      timeframe: effectiveTimeframe,
      currency: params.currency,
      from: requestedFrom,
      to: requestedTo,
      before: cursor ? pageBefore : undefined,
      limit: effectiveLimit + 1,
    });
  }

  const selectedCandles = pageCandles.slice(0, effectiveLimit);
  const result = selectedCandles.map(toMoralisCandle);
  const nextCursor = (providerTruncated || pageCandles.length > effectiveLimit) && selectedCandles.length > 0
    ? encodeCursor({
        beforeDate: selectedCandles[selectedCandles.length - 1]!.timestamp.toISOString(),
        effectiveTimeframe,
      })
    : null;
  const newestReturned = selectedCandles[0]?.timestamp ?? null;
  const oldestReturned = selectedCandles[selectedCandles.length - 1]?.timestamp ?? null;

  const response = {
    body: {
      cursor: nextCursor,
      result,
    },
    headers: buildCompatibilityHeaders({
      source,
      cuUsed,
      requestedTimeframe: params.timeframe,
      effectiveTimeframe,
      effectiveLimit,
      pageFrom: oldestReturned,
      pageTo: newestReturned,
    }),
  };

  await setJsonCache(compatCacheKey, response, getChartCacheTtl(effectiveTimeframe));
  return response;
}

function getPairAddress(params: unknown) {
  const parsed = z.object({ pairAddress: z.string().min(1) }).safeParse(params);

  if (!parsed.success) {
    throw badRequest('pairAddress is required');
  }

  return parsed.data.pairAddress;
}

function clampLimit(timeframe: OhlcvTimeframe, requestedLimit: number | undefined) {
  const maxForTimeframe = Math.min(MAX_LIMIT, maxSyncCandlesByTimeframe[timeframe]);
  const requested = requestedLimit ?? DEFAULT_LIMIT;

  if (!Number.isFinite(requested)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(Math.max(1, requested), maxForTimeframe);
}

async function getExternalApiKeyCuUsedToday(externalApiKeyId: string) {
  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  return providerUsageRepository.sumEstimatedCu({
    provider: 'moralis',
    from: startOfDay,
    to: now,
    externalApiKeyId,
  });
}

function setCompatibilityHeaders(reply: FastifyReply, headers: Record<string, string>) {
  for (const [key, value] of Object.entries(headers)) {
    reply.header(key, value);
  }
}

function buildCompatibilityHeaders(params: {
  source: string;
  cuUsed: number;
  requestedTimeframe: OhlcvTimeframe;
  effectiveTimeframe: OhlcvTimeframe;
  effectiveLimit: number;
  pageFrom: Date | null;
  pageTo: Date | null;
}) {
  return {
    'x-cache-source': params.source,
    'x-moralis-cu-used': String(params.cuUsed),
    'x-requested-timeframe': params.requestedTimeframe,
    'x-effective-timeframe': params.effectiveTimeframe,
    'x-effective-limit': String(params.effectiveLimit),
    'x-page-from': params.pageFrom?.toISOString() ?? '',
    'x-page-to': params.pageTo?.toISOString() ?? '',
  };
}

function toMoralisCandle(candle: StoredCandle | ChartCandle): MoralisOhlcvCandle {
  const timestamp = candle.timestamp instanceof Date ? candle.timestamp.toISOString() : candle.timestamp;
  const result: MoralisOhlcvCandle = {
    timestamp,
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
  };

  if (candle.volume !== null) {
    result.volume = Number(candle.volume);
  }

  if (candle.trades !== null) {
    result.trades = candle.trades;
  }

  return result;
}

function toTokenOhlcBody(storedCandles: StoredCandle[], result: MoralisOhlcvCandle[]): TokenOhlcResponse {
  return {
    s: storedCandles.length > 0 ? 'ok' : 'no_data',
    t: storedCandles.map((candle) => Math.floor(candle.timestamp.getTime() / 1000)),
    o: storedCandles.map((candle) => Number(candle.open)),
    h: storedCandles.map((candle) => Number(candle.high)),
    l: storedCandles.map((candle) => Number(candle.low)),
    c: storedCandles.map((candle) => Number(candle.close)),
    v: storedCandles.map((candle) => Number(candle.volume ?? 0)),
    result,
  };
}

function warmExternalCacheInBackground(params: {
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  from: Date;
  to: Date;
  cachedCandles: number;
}) {
  if (params.cachedCandles > 0) {
    return;
  }

  void enqueueBackfillJob({
    chain: params.chain,
    pairAddress: params.pairAddress,
    timeframe: params.timeframe,
    currency: params.currency,
    from: params.from.toISOString(),
    to: params.to.toISOString(),
    priority: 'normal',
    reason: 'user_gap',
  }).catch(() => undefined);
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
    throw badRequest('Invalid cursor');
  }
}

function encodeCursor(cursor: MoralisCompatCursor) {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function normalizeChainId(chainId: string) {
  const normalized = chainId.trim().toLowerCase();

  if (normalized === '8453' || normalized === '0x2105') {
    return 'base';
  }

  if (normalized === '1' || normalized === '0x1') {
    return 'eth';
  }

  return normalized;
}

function mapResolutionToTimeframe(resolution: string): OhlcvTimeframe {
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
    throw badRequest(`Unsupported resolution: ${resolution}`);
  }

  return timeframe;
}

function buildMoralisCompatCacheKey(params: {
  chain: string;
  pairAddress: string;
  requestedTimeframe: OhlcvTimeframe;
  effectiveTimeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  from: Date;
  to: Date;
  limit: number;
}) {
  return [
    'moralis-compat',
    'v3',
    params.chain,
    normalizePairAddress(params.chain, params.pairAddress),
    params.requestedTimeframe,
    params.effectiveTimeframe,
    params.currency,
    params.from.toISOString(),
    params.to.toISOString(),
    String(params.limit),
  ].join(':');
}

function buildTokenOhlcCacheKey(params: {
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  from: Date;
  to: Date;
  limit: number;
}) {
  return [
    'token-ohlc',
    'v1',
    params.chain,
    normalizePairAddress(params.chain, params.pairAddress),
    params.timeframe,
    params.currency,
    params.from.toISOString(),
    params.to.toISOString(),
    String(params.limit),
  ].join(':');
}

function buildTokenOhlcCountbackCacheKey(params: {
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  to: Date;
  countBack: number;
}) {
  return [
    'token-ohlc-countback',
    'v1',
    params.chain,
    normalizePairAddress(params.chain, params.pairAddress),
    params.timeframe,
    params.currency,
    params.to.toISOString(),
    String(params.countBack),
  ].join(':');
}

function getCountbackWarmFrom(to: Date, timeframe: OhlcvTimeframe, countBack: number) {
  const timeframeMs = timeframeSeconds[timeframe] * 1000;
  const overscan = Math.max(countBack * 3, countBack + 100);

  return new Date(to.getTime() - timeframeMs * overscan);
}

