import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.MORALIS_API_KEY = 'test-moralis-key';
  process.env.COINGECKO_API_KEY = 'test-coingecko-key';
  process.env.COINGECKO_OHLCV_ENABLED = 'true';
  process.env.COINGECKO_API_BASE_URL = 'https://pro-api.coingecko.com/api/v3';
  process.env.OHLCV_DEFAULT_PROVIDER = 'moralis';

  return {
    fetchCalls: [] as Array<{ url: string; init: RequestInit }>,
  };
});

vi.mock('../../repositories/providerUsage.js', () => ({
  providerUsageRepository: {
    sumEstimatedCu: vi.fn(async () => 0),
  },
}));

vi.mock('../../interactionLog.js', () => ({
  appendInteractionTraceEvent: vi.fn(async () => undefined),
}));

function timestampSeconds(iso: string) {
  return Math.floor(new Date(iso).getTime() / 1000);
}

describe('CoinGecko OHLCV provider', () => {
  beforeEach(() => {
    state.fetchCalls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: URL, init: RequestInit) => {
      state.fetchCalls.push({ url: url.toString(), init });
      return new Response(
        JSON.stringify({
          data: {
            attributes: {
              ohlcv_list: [
                [timestampSeconds('2026-01-01T00:15:00.000Z'), 4, 6, 3, 5, 40],
                [timestampSeconds('2026-01-01T00:10:00.000Z'), 2, 5, 1.5, 4, 30],
                [timestampSeconds('2026-01-01T00:05:00.000Z'), 1.5, 3, 1, 2, 20],
                [timestampSeconds('2026-01-01T00:00:00.000Z'), 1, 2, 0.5, 1.5, 10],
              ],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }));
  });

  it('calls CoinGecko pool OHLCV by network/pool and locally aggregates unsupported intervals', async () => {
    const { fetchCoinGeckoOhlcv } = await import('./coingeckoProvider.js');

    const result = await fetchCoinGeckoOhlcv({
      chain: 'base',
      pairAddress: '0xpool',
      timeframe: '10min',
      currency: 'usd',
      fromDate: new Date('2026-01-01T00:00:00.000Z'),
      toDate: new Date('2026-01-01T00:20:00.000Z'),
      maxPages: 1,
    });

    expect(state.fetchCalls).toHaveLength(1);
    const call = state.fetchCalls[0]!;
    const url = new URL(call.url);
    expect(url.pathname).toBe('/api/v3/onchain/networks/base/pools/0xpool/ohlcv/minute');
    expect(url.searchParams.get('aggregate')).toBe('5');
    expect(url.searchParams.get('limit')).toBe('1000');
    expect(url.searchParams.get('include_empty_intervals')).toBe('false');
    expect((call.init.headers as Record<string, string>)['x-cg-pro-api-key']).toBe('test-coingecko-key');

    expect(result.pages).toBe(1);
    expect(result.estimatedCu).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.candles).toEqual([
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        open: 1,
        high: 3,
        low: 0.5,
        close: 2,
        volume: 30,
      },
      {
        timestamp: '2026-01-01T00:10:00.000Z',
        open: 2,
        high: 6,
        low: 1.5,
        close: 5,
        volume: 70,
      },
    ]);
  });
});
