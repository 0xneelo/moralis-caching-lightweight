import crypto from 'node:crypto';
import { normalizePairAddress } from './pairAddress.js';
import { redis } from './redis.js';

export async function withRedisLock<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>
): Promise<T | undefined> {
  const token = crypto.randomUUID();
  const acquired = await redis.set(key, token, 'PX', ttlMs, 'NX');

  if (!acquired) {
    return undefined;
  }

  try {
    return await fn();
  } finally {
    const currentToken = await redis.get(key);
    if (currentToken === token) {
      await redis.del(key);
    }
  }
}

export function buildGapFetchLockKey(params: {
  chain: string;
  pairAddress: string;
  timeframe: string;
  currency: string;
  from: Date;
  to: Date;
}) {
  return [
    'lock',
    'ohlcv',
    params.chain,
    normalizePairAddress(params.chain, params.pairAddress),
    params.timeframe,
    params.currency,
    params.from.toISOString(),
    params.to.toISOString(),
  ].join(':');
}
