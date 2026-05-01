import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { badRequest } from '../httpErrors.js';
import { getOhlcvForChart } from '../services/chartService.js';
import { getEffectiveAdaptiveTimeframe, isOhlcvTimeframe } from '../timeframes.js';
import type { OhlcvCurrency, OhlcvTimeframe } from '../types.js';

const chartQuerySchema = z.object({
  chain: z.string().min(1),
  pairAddress: z.string().min(1),
  timeframe: z.custom<OhlcvTimeframe>((value) => typeof value === 'string' && isOhlcvTimeframe(value), {
    message: 'Unsupported timeframe',
  }),
  currency: z.enum(['usd', 'native']).optional(),
  from: z.string().datetime(),
  to: z.string().datetime(),
  visibleFrom: z.string().datetime().optional(),
  visibleTo: z.string().datetime().optional(),
  requestedTimeframe: z
    .custom<OhlcvTimeframe>((value) => typeof value === 'string' && isOhlcvTimeframe(value), {
      message: 'Unsupported requested timeframe',
    })
    .optional(),
});

export async function registerChartRoutes(app: FastifyInstance) {
  app.get('/api/charts/ohlcv', async (request, reply) => {
    const parsed = chartQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    const currency = (parsed.data.currency ?? config.DEFAULT_CURRENCY) as OhlcvCurrency;
    const from = new Date(parsed.data.from);
    const to = new Date(parsed.data.to);
    const visibleFrom = parsed.data.visibleFrom ? new Date(parsed.data.visibleFrom) : from;
    const visibleTo = parsed.data.visibleTo ? new Date(parsed.data.visibleTo) : to;
    const requestedTimeframe = parsed.data.requestedTimeframe ?? parsed.data.timeframe;
    const interactionId = request.headers['x-interaction-id']?.toString();
    const effectiveTimeframe = getEffectiveAdaptiveTimeframe({
      requestedTimeframe,
      from: visibleFrom,
      to: visibleTo,
    });

    const response = await getOhlcvForChart({
      chain: parsed.data.chain,
      pairAddress: parsed.data.pairAddress,
      timeframe: effectiveTimeframe,
      requestedTimeframe,
      currency,
      from,
      to,
      visibleFrom,
      visibleTo,
      userId: request.headers['x-user-id']?.toString(),
      ip: request.ip,
      maxProviderPages: 1,
      maxProviderFetches: 1,
      interactionId,
    });

    reply.header('x-requested-timeframe', requestedTimeframe);
    reply.header('x-effective-timeframe', effectiveTimeframe);
    reply.header('x-cache-source', response.source);

    return response;
  });
}
