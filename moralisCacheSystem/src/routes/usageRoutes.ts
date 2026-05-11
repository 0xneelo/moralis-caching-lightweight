import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { providerUsageRepository } from '../repositories/providerUsage.js';

export async function registerUsageRoutes(app: FastifyInstance) {
  app.get('/api/usage/moralis', async () => providerUsageRepository.getSummary());
  app.get('/api/usage/moralis/cooldown-skips', async (request) => {
    const parsed = z
      .object({
        limit: z.coerce.number().int().positive().max(1000).optional(),
      })
      .safeParse(request.query);

    const limit = parsed.success ? parsed.data.limit : undefined;
    return {
      events: await providerUsageRepository.getThrottleEvents({ limit }),
    };
  });
}
