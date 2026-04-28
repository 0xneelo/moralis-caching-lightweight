import cors from '@fastify/cors';
import Fastify from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { logger } from './logger.js';
import { assertChartRangeAllowed, isOhlcvTimeframe } from './timeframes.js';
import type { ChartCandle, MoralisCandle, OhlcvCurrency, OhlcvTimeframe } from './types.js';

const MORALIS_OHLC_CU_COST = 150;
const candles = new Map<string, ChartCandle[]>();
const responses = new Map<string, unknown>();
const usage = {
  todayCu: 0,
  totalCu: 0,
  todayRequests: 0,
  totalRequests: 0,
  since: startOfUtcDay(new Date()).toISOString(),
  updatedAt: new Date().toISOString(),
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
});

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

app.get('/api/charts/ohlcv', async (request, reply) => {
  const parsed = chartQuerySchema.safeParse(request.query);

  if (!parsed.success) {
    return reply.status(400).send({
      error: parsed.error.issues.map((issue) => issue.message).join(', '),
    });
  }

  const pairAddress = parsed.data.pairAddress.toLowerCase();
  const from = new Date(parsed.data.from);
  const to = new Date(parsed.data.to);

  try {
    assertChartRangeAllowed({
      timeframe: parsed.data.timeframe,
      from,
      to,
    });
  } catch (error) {
    return reply.status(400).send({
      error: error instanceof Error ? error.message : 'Invalid chart request',
    });
  }

  const responseKey = buildKey({
    chain: parsed.data.chain,
    pairAddress,
    timeframe: parsed.data.timeframe,
    currency: parsed.data.currency,
    from,
    to,
  });

  const cachedResponse = responses.get(responseKey);
  if (cachedResponse) {
    return cachedResponse;
  }

  const candleKey = buildCandleKey({
    chain: parsed.data.chain,
    pairAddress,
    timeframe: parsed.data.timeframe,
    currency: parsed.data.currency,
  });

  let stored = candles.get(candleKey) ?? [];
  const matching = filterCandles(stored, from, to);
  let responseSource: 'cache' | 'cache+moralis' | 'demo' = matching.length > 0 ? 'cache' : 'cache+moralis';

  if (matching.length === 0) {
    if (!config.MORALIS_API_KEY) {
      logger.warn('MORALIS_API_KEY is missing. Returning demo candles for local UI mode.');
      stored = mergeCandles(stored, createDemoCandles(from, to, parsed.data.timeframe));
      candles.set(candleKey, stored);
      responseSource = 'demo';
    } else {
      try {
        const result = await fetchMoralisOhlcvLocal({
          chain: parsed.data.chain,
          pairAddress,
          timeframe: parsed.data.timeframe,
          currency: parsed.data.currency,
          from,
          to,
          maxPages: config.MAX_SYNC_MORALIS_PAGES,
        });

        if (result.candles.length === 0) {
          logger.warn(
            {
              pairAddress,
              timeframe: parsed.data.timeframe,
              from: from.toISOString(),
              to: to.toISOString(),
            },
            'Moralis returned zero candles. Returning demo candles for local UI mode.'
          );
          stored = mergeCandles(stored, createDemoCandles(from, to, parsed.data.timeframe));
          responseSource = 'demo';
        } else {
          stored = mergeCandles(stored, result.candles.map(toChartCandle));
          responseSource = 'cache+moralis';
        }

        candles.set(candleKey, stored);

        logger.info(
          {
            provider: 'moralis',
            pairAddress,
            timeframe: parsed.data.timeframe,
            pages: result.pages,
            returnedCandles: result.candles.length,
            estimatedCu: result.pages * MORALIS_OHLC_CU_COST,
            mode: 'local-memory',
          },
          'Fetched local missing candles from Moralis'
        );

        recordMoralisUsage(result.pages);
      } catch (error) {
        logger.error(
          {
            error,
            pairAddress,
            chain: parsed.data.chain,
            timeframe: parsed.data.timeframe,
            from: from.toISOString(),
            to: to.toISOString(),
          },
          'Moralis local fetch failed. Returning demo candles for local UI mode.'
        );

        stored = mergeCandles(stored, createDemoCandles(from, to, parsed.data.timeframe));
        candles.set(candleKey, stored);
        responseSource = 'demo';
      }
    }
  }

  const finalCandles = filterCandles(candles.get(candleKey) ?? [], from, to);
  const response = {
    chain: parsed.data.chain,
    pairAddress,
    timeframe: parsed.data.timeframe,
    currency: parsed.data.currency,
    from: from.toISOString(),
    to: to.toISOString(),
    source: responseSource,
    partial: false,
    candles: finalCandles,
  };

  responses.set(responseKey, response);
  return response;
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

function createDemoCandles(from: Date, to: Date, timeframe: OhlcvTimeframe): ChartCandle[] {
  const maxCandles = 240;
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const rangeMs = Math.max(1, toMs - fromMs);
  const stepMs = Math.max(60_000, Math.floor(rangeMs / maxCandles));
  const candles: ChartCandle[] = [];
  let previousClose = 0.0012;

  for (let index = 0; index <= maxCandles; index += 1) {
    const timestampMs = fromMs + index * stepMs;
    if (timestampMs > toMs) {
      break;
    }

    const wave = Math.sin(index / 9) * 0.00008 + Math.cos(index / 23) * 0.00005;
    const drift = index / maxCandles * 0.00045;
    const open = previousClose;
    const close = Math.max(0.00005, 0.0012 + drift + wave);
    const high = Math.max(open, close) * (1 + 0.015 + (index % 7) * 0.001);
    const low = Math.min(open, close) * (1 - 0.014 - (index % 5) * 0.001);
    const volume = 4000 + Math.abs(Math.sin(index / 5)) * 26000;

    previousClose = close;
    candles.push({
      time: Math.floor(timestampMs / 1000),
      timestamp: new Date(timestampMs).toISOString(),
      open,
      high,
      low,
      close,
      volume,
      trades: 8 + (index % 27),
    });
  }

  logger.info(
    {
      timeframe,
      candles: candles.length,
      from: from.toISOString(),
      to: to.toISOString(),
    },
    'Generated demo candles for local UI mode'
  );

  return candles;
}

async function fetchMoralisOhlcvLocal(params: {
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  from: Date;
  to: Date;
  maxPages: number;
}) {
  const result: MoralisCandle[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    if (pages >= params.maxPages) {
      break;
    }

    const url = new URL(`https://deep-index.moralis.io/api/v2.2/pairs/${params.pairAddress}/ohlcv`);
    url.searchParams.set('chain', params.chain);
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
      throw new Error(`Moralis local fetch failed: ${response.status} ${await response.text()}`);
    }

    const json = (await response.json()) as {
      cursor?: string | null;
      result?: MoralisCandle[];
    };

    result.push(...(json.result ?? []));
    cursor = json.cursor ?? undefined;
    pages += 1;
  } while (cursor);

  return {
    candles: result,
    pages,
  };
}

function recordMoralisUsage(pages: number) {
  const estimatedCu = pages * MORALIS_OHLC_CU_COST;
  usage.todayCu += estimatedCu;
  usage.totalCu += estimatedCu;
  usage.todayRequests += pages;
  usage.totalRequests += pages;
  usage.updatedAt = new Date().toISOString();
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
