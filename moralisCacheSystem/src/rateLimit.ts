import { redis } from './redis.js';
import { tooManyRequests } from './httpErrors.js';

export async function enforceChartRateLimit(params: {
  userId?: string | undefined;
  ip: string;
  pairAddress: string;
}) {
  const actor = params.userId ? `user:${params.userId}` : `ip:${params.ip}`;
  const generalKey = `rate:chart:${actor}`;
  const pairKey = `rate:chart:${actor}:${params.pairAddress.toLowerCase()}`;

  const [generalCount, pairCount] = await Promise.all([
    incrementWindow(generalKey, 60),
    incrementWindow(pairKey, 60),
  ]);

  if (generalCount > 120) {
    throw tooManyRequests('Chart rate limit exceeded');
  }

  if (pairCount > 60) {
    throw tooManyRequests('Chart pair rate limit exceeded');
  }
}

export async function enforceProviderMissRateLimit(params: {
  userId?: string | undefined;
  ip: string;
}) {
  const actor = params.userId ? `user:${params.userId}` : `ip:${params.ip}`;
  const count = await incrementWindow(`rate:chart-miss:${actor}`, 60);

  if (count > 10) {
    throw tooManyRequests('Chart cache miss rate limit exceeded');
  }
}

async function incrementWindow(key: string, ttlSeconds: number) {
  const count = await redis.incr(key);

  if (count === 1) {
    await redis.expire(key, ttlSeconds);
  }

  return count;
}
