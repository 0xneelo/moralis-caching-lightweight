import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authenticateExternalApiKey } from '../auth/externalApiKeyAuth.js';
import { config } from '../config.js';
import { badRequest } from '../httpErrors.js';
import { enforceExternalApiKeyRequestRateLimit } from '../rateLimit.js';
import { providerUsageRepository } from '../repositories/providerUsage.js';
import { getOhlcvForChart } from '../services/chartService.js';
import {
  getEffectiveAdaptiveTimeframe,
  isOhlcvTimeframe,
  maxSyncCandlesByTimeframe,
  timeframeSeconds,
} from '../timeframes.js';
import type { ChartCandle, OhlcvCurrency, OhlcvTimeframe } from '../types.js';

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

type MoralisCompatResult = {
  body: MoralisOhlcvResponse;
  headers: Record<string, string>;
};

type MoralisCompatCursor = {
  fromDate: string;
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

export async function registerMoralisCompatRoutes(app: FastifyInstance) {
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
      chain: parsed.data.chain ?? 'eth',
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

  const effectiveTimeframe = getEffectiveAdaptiveTimeframe({
    requestedTimeframe: params.timeframe,
    from: requestedFrom,
    to: requestedTo,
  });
  const effectiveLimit = clampLimit(effectiveTimeframe, params.requestedLimit);
  const pageWindow = getPageWindow({
    cursor: params.cursor,
    fromDate: params.fromDate,
    toDate: params.toDate,
    timeframe: effectiveTimeframe,
    limit: effectiveLimit,
  });

  if (!pageWindow) {
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

  const cuBefore = await getExternalApiKeyCuUsedToday(params.externalApiKeyId);
  const response = await getOhlcvForChart({
    chain: params.chain,
    pairAddress: params.pairAddress,
    timeframe: effectiveTimeframe,
    requestedTimeframe: params.timeframe,
    currency: params.currency,
    from: pageWindow.from,
    to: pageWindow.to,
    userId: params.userId,
    ip: params.ip,
    externalApiKeyId: params.externalApiKeyId,
    maxProviderPages: 1,
    maxProviderFetches: 1,
  });
  const cuAfter = await getExternalApiKeyCuUsedToday(params.externalApiKeyId);

  const result = response.candles.slice(0, effectiveLimit).map(toMoralisCandle);
  const cursor =
    pageWindow.nextFrom && pageWindow.nextFrom < pageWindow.requestedTo
      ? encodeCursor({
          fromDate: pageWindow.nextFrom.toISOString(),
          effectiveTimeframe,
        })
      : null;

  return {
    body: {
      cursor,
      result,
    },
    headers: buildCompatibilityHeaders({
      source: response.source,
      cuUsed: Math.max(0, cuAfter - cuBefore),
      requestedTimeframe: params.timeframe,
      effectiveTimeframe,
      effectiveLimit,
      pageFrom: pageWindow.from,
      pageTo: pageWindow.to,
    }),
  };
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

function toMoralisCandle(candle: ChartCandle): MoralisOhlcvCandle {
  const result: MoralisOhlcvCandle = {
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
    throw badRequest('Invalid cursor');
  }

  const from = cursor ? new Date(cursor.fromDate) : requestedFrom;

  if (requestedTo <= requestedFrom) {
    throw badRequest('Invalid chart range');
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
    throw badRequest('Invalid cursor');
  }
}

function encodeCursor(cursor: MoralisCompatCursor) {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

