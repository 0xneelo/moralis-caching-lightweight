import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { badRequest, unauthorized } from '../httpErrors.js';
import { enqueueBackfillJob } from '../jobs/enqueue.js';
import { normalizePairAddress } from '../pairAddress.js';
import { redis } from '../redis.js';
import { externalApiKeyRepository } from '../repositories/externalApiKeys.js';
import { isOhlcvTimeframe } from '../timeframes.js';
import type { OhlcvTimeframe } from '../types.js';

const backfillBodySchema = z.object({
  chain: z.string().min(1),
  pairAddress: z.string().min(1),
  timeframes: z
    .array(
      z.custom<OhlcvTimeframe>((value) => typeof value === 'string' && isOhlcvTimeframe(value), {
        message: 'Unsupported timeframe',
      })
    )
    .min(1),
  currency: z.enum(['usd', 'native']).default('usd'),
  from: z.string().datetime(),
  to: z.string().datetime(),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
});

const createApiKeyBodySchema = z.object({
  name: z.string().min(1),
  scopes: z.array(z.enum(['ohlcv:read'])).min(1).optional(),
});

export async function registerAdminRoutes(app: FastifyInstance) {
  app.post('/api/admin/charts/backfill', async (request) => {
    assertAdmin(request);

    const parsed = backfillBodySchema.safeParse(request.body);

    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    const jobs = [];

    for (const timeframe of parsed.data.timeframes) {
      jobs.push(
        await enqueueBackfillJob({
          chain: parsed.data.chain,
          pairAddress: normalizePairAddress(parsed.data.chain, parsed.data.pairAddress),
          timeframe,
          currency: parsed.data.currency,
          from: parsed.data.from,
          to: parsed.data.to,
          priority: parsed.data.priority,
          reason: 'admin',
        })
      );
    }

    return { jobs };
  });

  app.post('/api/admin/moralis/enabled', async (request) => {
    assertAdmin(request);

    const parsed = z.object({ enabled: z.boolean() }).safeParse(request.body);

    if (!parsed.success) {
      throw badRequest('Body must include enabled boolean');
    }

    await redis.set('feature:moralis_ohlcv_enabled', parsed.data.enabled ? 'true' : 'false');

    return { enabled: parsed.data.enabled };
  });

  app.post('/api/admin/api-keys', async (request) => {
    assertAdmin(request);

    const parsed = createApiKeyBodySchema.safeParse(request.body);

    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    const createParams =
      parsed.data.scopes === undefined
        ? { name: parsed.data.name }
        : { name: parsed.data.name, scopes: parsed.data.scopes };

    return externalApiKeyRepository.create(createParams);
  });

  app.get('/api/admin/api-keys', async (request) => {
    assertAdmin(request);

    return {
      apiKeys: await externalApiKeyRepository.list(),
    };
  });

  app.delete('/api/admin/api-keys/:id', async (request) => {
    assertAdmin(request);

    const parsed = z.object({ id: z.string().min(1) }).safeParse(request.params);

    if (!parsed.success) {
      throw badRequest('API key id is required');
    }

    const apiKey = await externalApiKeyRepository.revoke(parsed.data.id);

    if (!apiKey) {
      throw badRequest('API key not found');
    }

    return { apiKey };
  });
}

function assertAdmin(request: FastifyRequest) {
  if (!config.ADMIN_API_KEY) {
    throw unauthorized('ADMIN_API_KEY is not configured');
  }

  const header = request.headers.authorization;
  const expected = `Bearer ${config.ADMIN_API_KEY}`;

  if (header !== expected) {
    throw unauthorized();
  }
}
