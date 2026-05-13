import type { FastifyRequest } from 'fastify';
import { unauthorized } from '../httpErrors.js';
import {
  externalApiKeyRepository,
  type ExternalApiKeyRecord,
} from '../repositories/externalApiKeys.js';

const API_KEY_AUTH_CACHE_TTL_MS = 5_000;
const authCache = new Map<string, { record: ExternalApiKeyRecord; expiresAt: number }>();

export async function authenticateExternalApiKey(
  request: FastifyRequest
): Promise<ExternalApiKeyRecord> {
  const apiKey = request.headers['x-api-key']?.toString();

  if (!apiKey) {
    throw unauthorized('X-API-Key header is required');
  }

  const now = Date.now();
  const cached = authCache.get(apiKey);
  const record =
    cached && cached.expiresAt > now
      ? cached.record
      : await externalApiKeyRepository.findActiveByApiKey(apiKey);

  if (!record) {
    authCache.delete(apiKey);
    throw unauthorized('Invalid API key');
  }

  if (!record.scopes.includes('ohlcv:read')) {
    authCache.delete(apiKey);
    throw unauthorized('API key is not allowed to read OHLCV data');
  }

  authCache.set(apiKey, {
    record,
    expiresAt: now + API_KEY_AUTH_CACHE_TTL_MS,
  });

  // Do not block request latency on accounting writes.
  void externalApiKeyRepository.markUsed(record.id).catch(() => undefined);
  return record;
}

