import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { badRequest } from '../httpErrors.js';
import { resolveRequestedOhlcvProvider } from '../providers/ohlcv/registry.js';
import { getOhlcvForChart } from '../services/chartService.js';
import { getEffectiveAdaptiveTimeframe, isOhlcvTimeframe } from '../timeframes.js';
import type { OhlcvCurrency, OhlcvProviderId, OhlcvTimeframe } from '../types.js';

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
  refreshFromMoralis: z.coerce.boolean().optional(),
  requestedTimeframe: z
    .custom<OhlcvTimeframe>((value) => typeof value === 'string' && isOhlcvTimeframe(value), {
      message: 'Unsupported requested timeframe',
    })
    .optional(),
  provider: z.enum(['moralis', 'coingecko']).optional(),
});

export async function registerChartRoutes(app: FastifyInstance) {
  app.get('/api/charts/ohlcv', async (request, reply) => {
    const parsed = chartQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    const currency = (parsed.data.currency ?? config.DEFAULT_CURRENCY) as OhlcvCurrency;
    const from = new Date(parsed.data.from);
    const now = new Date();
    const to = new Date(Math.min(new Date(parsed.data.to).getTime(), now.getTime()));
    const visibleFromCandidate = parsed.data.visibleFrom ? new Date(parsed.data.visibleFrom) : from;
    const visibleFrom = new Date(Math.min(visibleFromCandidate.getTime(), to.getTime()));
    const visibleTo = new Date(
      Math.min(parsed.data.visibleTo ? new Date(parsed.data.visibleTo).getTime() : to.getTime(), to.getTime())
    );

    if (to <= from) {
      throw badRequest('Invalid chart range');
    }
    const requestedTimeframe = parsed.data.requestedTimeframe ?? parsed.data.timeframe;
    const provider = resolveRequestedOhlcvProvider(parsed.data.provider) as OhlcvProviderId;
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
      refreshFromMoralis: parsed.data.refreshFromMoralis ?? false,
      provider,
    });

    reply.header('x-requested-timeframe', requestedTimeframe);
    reply.header('x-effective-timeframe', effectiveTimeframe);
    reply.header('x-ohlcv-provider', provider);
    reply.header('x-cache-source', response.source);
    reply.header('x-history-complete', String(response.historyComplete));
    reply.header('x-history-warming', String(response.historyWarming));
    if (response.historyProgressPct !== null) {
      reply.header('x-history-progress-pct', String(response.historyProgressPct));
    }
    if (response.marketStart) {
      reply.header('x-market-start', response.marketStart);
    }

    return response;
  });
}
