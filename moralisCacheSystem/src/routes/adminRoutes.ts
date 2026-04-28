import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { badRequest, unauthorized } from '../httpErrors.js';
import { enqueueBackfillJob } from '../jobs/enqueue.js';
import { redis } from '../redis.js';
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
          pairAddress: parsed.data.pairAddress.toLowerCase(),
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
