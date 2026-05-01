import type { FastifyRequest } from 'fastify';
import { unauthorized } from '../httpErrors.js';
import {
  externalApiKeyRepository,
  type ExternalApiKeyRecord,
} from '../repositories/externalApiKeys.js';

export async function authenticateExternalApiKey(
  request: FastifyRequest
): Promise<ExternalApiKeyRecord> {
  const apiKey = request.headers['x-api-key']?.toString();

  if (!apiKey) {
    throw unauthorized('X-API-Key header is required');
  }

  const record = await externalApiKeyRepository.findActiveByApiKey(apiKey);

  if (!record) {
    throw unauthorized('Invalid API key');
  }

  if (!record.scopes.includes('ohlcv:read')) {
    throw unauthorized('API key is not allowed to read OHLCV data');
  }

  await externalApiKeyRepository.markUsed(record.id);
  return record;
}

