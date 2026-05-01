import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeInteractionLogFile } from '../interactionLog.js';

const interactionEventSchema = z.object({
  interactionId: z.string().min(1).optional(),
  event: z.enum(['chart_range_click', 'candle_resolution_click']),
  selectedValue: z.string().min(1),
  previousValue: z.string().min(1).optional(),
  chain: z.string().min(1).optional(),
  pairAddress: z.string().min(1).optional(),
  requestedTimeframe: z.string().min(1).optional(),
  effectiveTimeframe: z.string().min(1).optional(),
  chartRange: z.string().min(1).optional(),
  visibleFrom: z.string().datetime().optional(),
  visibleTo: z.string().datetime().optional(),
  loadedCandles: z.number().int().nonnegative().optional(),
  source: z.string().min(1).optional(),
});

export async function registerInteractionRoutes(app: FastifyInstance) {
  app.post('/api/debug/interactions', async (request, reply) => {
    const parsed = interactionEventSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: parsed.error.issues.map((issue) => issue.message).join(', '),
      });
    }

    const result = await writeInteractionLogFile(parsed.data);

    return { ok: true, ...result };
  });
}
