import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChartOhlcvResponse, MoralisCandle } from '../types.js';

const state = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.MORALIS_API_KEY = 'test-moralis-key';
  process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/moralis_cache_test';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.CHART_PROVIDER_ENABLED = 'true';
  process.env.MAX_SYNC_MORALIS_PAGES = '3';
  process.env.MAX_SYNC_GAP_CANDLES = '3000';

  return {
    redisStore: new Map<string, string>(),
    candles: [] as Array<{
      chain: string;
      pairAddress: string;
      timeframe: string;
      currency: string;
      timestamp: Date;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string | null;
      trades: number | null;
    }>,
    providerUsage: [] as unknown[],
    backfillJobs: [] as unknown[],
    moralisCalls: 0,
  };
});

vi.mock('../redis.js', () => {
  const redis = {
    async get(key: string) {
      return state.redisStore.get(key) ?? null;
    },
    async set(key: string, value: string, ...args: unknown[]) {
      const usesNx = args.includes('NX');
      if (usesNx && state.redisStore.has(key)) {
        return null;
      }

      state.redisStore.set(key, value);
      return 'OK';
    },
    async incr(key: string) {
      const next = Number(state.redisStore.get(key) ?? 0) + 1;
      state.redisStore.set(key, String(next));
      return next;
    },
    async expire() {
      return 1;
    },
    async del(key: string) {
      const existed = state.redisStore.delete(key);
      return existed ? 1 : 0;
    },
    async ping() {
      return 'PONG';
    },
    async quit() {
      return 'OK';
    },
  };

  return {
    redis,
    createQueueRedisConnection: () => redis,
    closeRedis: vi.fn(),
  };
});

vi.mock('../repositories/candles.js', () => ({
  candleRepository: {
    async findCandles(params: {
      chain: string;
      pairAddress: string;
      timeframe: string;
      currency: string;
      from: Date;
      to: Date;
    }) {
      return state.candles
        .filter(
          (candle) =>
            candle.chain === params.chain &&
            candle.pairAddress === params.pairAddress &&
            candle.timeframe === params.timeframe &&
            candle.currency === params.currency &&
            candle.timestamp >= params.from &&
            candle.timestamp <= params.to
        )
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    },
    async upsertCandles(params: {
      chain: string;
      pairAddress: string;
      timeframe: string;
      currency: string;
      candles: MoralisCandle[];
    }) {
      for (const candle of params.candles) {
        const timestamp = new Date(candle.timestamp);
        const existingIndex = state.candles.findIndex(
          (row) =>
            row.chain === params.chain &&
            row.pairAddress === params.pairAddress &&
            row.timeframe === params.timeframe &&
            row.currency === params.currency &&
            row.timestamp.getTime() === timestamp.getTime()
        );

        const row = {
          chain: params.chain,
          pairAddress: params.pairAddress,
          timeframe: params.timeframe,
          currency: params.currency,
          timestamp,
          open: String(candle.open),
          high: String(candle.high),
          low: String(candle.low),
          close: String(candle.close),
          volume: candle.volume === undefined ? null : String(candle.volume),
          trades: candle.trades ?? null,
        };

        if (existingIndex >= 0) {
          state.candles[existingIndex] = row;
        } else {
          state.candles.push(row);
        }
      }

      return { inserted: params.candles.length };
    },
  },
}));

vi.mock('../repositories/pairs.js', () => ({
  pairRepository: {
    touchPair: vi.fn(),
    findHotPairs: vi.fn(async () => []),
  },
}));

vi.mock('../repositories/providerUsage.js', () => ({
  providerUsageRepository: {
    async log(entry: unknown) {
      state.providerUsage.push(entry);
    },
    async sumEstimatedCu() {
      return 0;
    },
    async getSummary() {
      return {
        todayCu: state.providerUsage.length * 150,
        totalCu: state.providerUsage.length * 150,
        todayRequests: state.providerUsage.length,
        totalRequests: state.providerUsage.length,
        since: '2026-04-28T00:00:00.000Z',
        updatedAt: '2026-04-28T00:00:00.000Z',
      };
    },
  },
}));

vi.mock('../jobs/enqueue.js', () => ({
  enqueueBackfillJob: vi.fn(async (job: unknown) => {
    state.backfillJobs.push(job);
    return { dbJobId: 'test-db-job', queueJobId: 'test-queue-job' };
  }),
}));

vi.mock('../moralis.js', () => ({
  fetchMoralisOhlcv: vi.fn(async () => {
    state.moralisCalls += 1;

    return {
      candles: [
        {
          timestamp: '2026-04-28T00:00:00.000Z',
          open: 1,
          high: 2,
          low: 0.9,
          close: 1.5,
          volume: 100,
          trades: 10,
        },
        {
          timestamp: '2026-04-28T01:00:00.000Z',
          open: 1.5,
          high: 2.5,
          low: 1.4,
          close: 2,
          volume: 150,
          trades: 12,
        },
      ],
      pages: 1,
      estimatedCu: 150,
      durationMs: 25,
      truncated: false,
    };
  }),
  isMoralisOhlcvEnabled: vi.fn(async () => true),
  assertMoralisOhlcvEnabled: vi.fn(async () => undefined),
}));

describe('chart API E2E', () => {
  beforeEach(() => {
    state.redisStore.clear();
    state.candles.length = 0;
    state.providerUsage.length = 0;
    state.backfillJobs.length = 0;
    state.moralisCalls = 0;
  });

  it('fetches missing candles once, stores them, and serves repeat requests from cache', async () => {
    const { buildServer } = await import('../server.js');
    const app = await buildServer();

    const url =
      '/api/charts/ohlcv?' +
      new URLSearchParams({
        chain: 'eth',
        pairAddress: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
        timeframe: '1h',
        currency: 'usd',
        from: '2026-04-28T00:00:00.000Z',
        to: '2026-04-28T02:00:00.000Z',
      }).toString();

    const firstResponse = await app.inject({
      method: 'GET',
      url,
      headers: {
        'x-user-id': 'user-1',
      },
    });

    expect(firstResponse.statusCode).toBe(200);

    const firstBody = firstResponse.json<ChartOhlcvResponse>();
    expect(firstBody.source).toBe('cache+moralis');
    expect(firstBody.partial).toBe(false);
    expect(firstBody.candles).toHaveLength(2);
    expect(state.moralisCalls).toBe(1);
    expect(state.providerUsage).toHaveLength(1);
    expect(state.candles).toHaveLength(2);

    const secondResponse = await app.inject({
      method: 'GET',
      url,
      headers: {
        'x-user-id': 'user-1',
      },
    });

    expect(secondResponse.statusCode).toBe(200);

    const secondBody = secondResponse.json<ChartOhlcvResponse>();
    expect(secondBody.candles).toHaveLength(2);
    expect(state.moralisCalls).toBe(1);
    expect(state.backfillJobs).toHaveLength(0);

    await app.close();
  });
});
