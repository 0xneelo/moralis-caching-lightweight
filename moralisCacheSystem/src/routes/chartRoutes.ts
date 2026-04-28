import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { badRequest } from '../httpErrors.js';
import { getOhlcvForChart } from '../services/chartService.js';
import { isOhlcvTimeframe } from '../timeframes.js';
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
});

export async function registerChartRoutes(app: FastifyInstance) {
  app.get('/api/charts/ohlcv', async (request) => {
    const parsed = chartQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    const currency = (parsed.data.currency ?? config.DEFAULT_CURRENCY) as OhlcvCurrency;

    return getOhlcvForChart({
      chain: parsed.data.chain,
      pairAddress: parsed.data.pairAddress,
      timeframe: parsed.data.timeframe,
      currency,
      from: new Date(parsed.data.from),
      to: new Date(parsed.data.to),
      userId: request.headers['x-user-id']?.toString(),
      ip: request.ip,
    });
  });
}
