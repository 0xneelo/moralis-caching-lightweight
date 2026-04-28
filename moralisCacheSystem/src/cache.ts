import { redis } from './redis.js';
import type { OhlcvTimeframe } from './types.js';

export function buildChartCacheKey(params: {
  chain: string;
  pairAddress: string;
  timeframe: string;
  currency: string;
  from: Date;
  to: Date;
}) {
  return [
    'chart',
    'ohlcv',
    params.chain,
    params.pairAddress.toLowerCase(),
    params.timeframe,
    params.currency,
    params.from.toISOString(),
    params.to.toISOString(),
  ].join(':');
}

export function getChartCacheTtl(timeframe: OhlcvTimeframe) {
  switch (timeframe) {
    case '1s':
    case '10s':
    case '30s':
      return 5;
    case '1min':
      return 15;
    case '5min':
    case '10min':
      return 30;
    case '30min':
    case '1h':
      return 60;
    default:
      return 300;
  }
}

export async function getJsonCache<T>(key: string) {
  const value = await redis.get(key);
  return value ? (JSON.parse(value) as T) : null;
}

export async function setJsonCache(key: string, value: unknown, ttlSeconds: number) {
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
}
