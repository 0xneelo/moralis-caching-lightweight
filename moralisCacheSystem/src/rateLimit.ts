import { redis } from './redis.js';
import { tooManyRequests } from './httpErrors.js';
import { config } from './config.js';
import { providerUsageRepository } from './repositories/providerUsage.js';

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

export async function enforceExternalApiKeyRequestRateLimit(params: { apiKeyId: string }) {
  const count = await incrementWindow(`rate:external-api-key:${params.apiKeyId}:requests`, 60);

  if (count > config.EXTERNAL_API_KEY_REQUEST_RATE_LIMIT) {
    throw tooManyRequests('External API key request rate limit exceeded');
  }
}

export async function enforceExternalApiKeyCacheMissRateLimit(params: { apiKeyId: string }) {
  const count = await incrementWindow(`rate:external-api-key:${params.apiKeyId}:cache-miss`, 60);

  if (count > config.EXTERNAL_API_KEY_CACHE_MISS_RATE_LIMIT) {
    throw tooManyRequests('External API key cache miss rate limit exceeded');
  }
}

export async function assertExternalApiKeyCuBudgetAvailable(params: {
  apiKeyId: string;
  estimatedCu: number;
}) {
  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const usedToday = await providerUsageRepository.sumEstimatedCu({
    provider: 'moralis',
    from: startOfDay,
    to: now,
    externalApiKeyId: params.apiKeyId,
  });

  if (usedToday + params.estimatedCu > config.EXTERNAL_API_KEY_DAILY_CU_BUDGET) {
    throw tooManyRequests('External API key daily CU budget exceeded');
  }
}

async function incrementWindow(key: string, ttlSeconds: number) {
  const count = await redis.incr(key);

  if (count === 1) {
    await redis.expire(key, ttlSeconds);
  }

  return count;
}
