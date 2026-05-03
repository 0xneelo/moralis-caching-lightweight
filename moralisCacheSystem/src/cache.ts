import { redis } from './redis.js';
import { normalizePairAddress } from './pairAddress.js';
import { timeframeSeconds } from './timeframes.js';
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
    'v5',
    params.chain,
    normalizePairAddress(params.chain, params.pairAddress),
    params.timeframe,
    params.currency,
    alignCacheBoundary(params.from, params.timeframe, 'floor').toISOString(),
    alignCacheBoundary(params.to, params.timeframe, 'ceil').toISOString(),
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

function alignCacheBoundary(date: Date, timeframe: string, direction: 'floor' | 'ceil') {
  const seconds = timeframeSeconds[timeframe as OhlcvTimeframe];

  if (!seconds) {
    return date;
  }

  const stepMs = seconds * 1000;
  const value = direction === 'floor'
    ? Math.floor(date.getTime() / stepMs) * stepMs
    : Math.ceil(date.getTime() / stepMs) * stepMs;

  return new Date(value);
}

export async function getJsonCache<T>(key: string) {
  const value = await redis.get(key);
  return value ? (JSON.parse(value) as T) : null;
}

export async function setJsonCache(key: string, value: unknown, ttlSeconds: number) {
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
}
