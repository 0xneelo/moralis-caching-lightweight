import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getAdminSettings, updateAdminSettings, type AdminSettingsPatch } from '../adminConfig.js';
import { cacheSnapshotSchema, countSnapshotCandles } from '../cacheSnapshot.js';
import { config } from '../config.js';
import { badRequest, unauthorized } from '../httpErrors.js';
import { enqueueBackfillJob } from '../jobs/enqueue.js';
import { normalizePairAddress } from '../pairAddress.js';
import { redis } from '../redis.js';
import { candleRepository } from '../repositories/candles.js';
import { externalApiKeyRepository } from '../repositories/externalApiKeys.js';
import { providerUsageRepository } from '../repositories/providerUsage.js';
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

const settingsPatchSchema = z.object({
  moralisOhlcvEnabled: z.boolean().optional(),
  moralisDailyCuBudget: z.number().int().positive().optional(),
  maxSyncMoralisPages: z.number().int().positive().optional(),
  maxSyncGapCandles: z.number().int().positive().optional(),
  externalApiKeyRequestRateLimit: z.number().int().positive().optional(),
  externalApiKeyCacheMissRateLimit: z.number().int().positive().optional(),
  externalApiKeyDailyCuBudget: z.number().int().positive().optional(),
});

export async function registerAdminRoutes(app: FastifyInstance) {
  app.get('/api/admin/session', async (request) => {
    assertAdmin(request);

    return {
      ok: true,
      settings: await getAdminSettings(),
    };
  });

  app.get('/api/admin/dashboard', async (request) => {
    assertAdmin(request);

    const [usage, breakdown, apiKeys, cacheInventory, throttleEvents, settings] = await Promise.all([
      providerUsageRepository.getSummary(),
      providerUsageRepository.getAdminBreakdown(),
      externalApiKeyRepository.list(),
      candleRepository.getInventory({ limit: 100 }),
      providerUsageRepository.getThrottleEvents({ limit: 50 }),
      getAdminSettings(),
    ]);

    return {
      usage,
      breakdown,
      runtimeMode: 'persistent',
      apiKeys,
      cacheInventory,
      throttleEvents,
      settings,
      updatedAt: new Date().toISOString(),
    };
  });

  app.get('/api/admin/settings', async (request) => {
    assertAdmin(request);

    return { settings: await getAdminSettings() };
  });

  app.patch('/api/admin/settings', async (request) => {
    assertAdmin(request);

    const parsed = settingsPatchSchema.safeParse(request.body);

    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    return { settings: await updateAdminSettings(toSettingsPatch(parsed.data)) };
  });

  app.get('/api/admin/cache/inventory', async (request) => {
    assertAdmin(request);

    const parsed = z
      .object({
        limit: z.coerce.number().int().positive().max(500).optional(),
      })
      .safeParse(request.query);

    return {
      markets: await candleRepository.getInventory({ limit: parsed.success ? parsed.data.limit : undefined }),
    };
  });

  app.post('/api/admin/cache/load-persistent', async (request) => {
    assertAdmin(request);

    const parsed = z
      .object({
        limit: z.coerce.number().int().positive().max(500).optional(),
      })
      .safeParse(request.body);

    const markets = await candleRepository.getInventory({ limit: parsed.success ? parsed.data.limit : undefined });
    return {
      mode: 'persistent',
      importedMarkets: markets.length,
      markets,
    };
  });

  app.get('/api/admin/cache/export', async (request, reply) => {
    assertAdmin(request);

    const snapshot = await candleRepository.exportSnapshot('persistent');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    reply
      .header('Content-Type', 'application/json')
      .header('Content-Disposition', `attachment; filename="moralis-cache-${timestamp}.json"`);

    return snapshot;
  });

  app.post('/api/admin/cache/import', async (request) => {
    assertAdmin(request);

    const parsed = cacheSnapshotSchema.safeParse(request.body);

    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    const result = await candleRepository.importSnapshot(parsed.data);
    return {
      ...result,
      totalSnapshotCandles: countSnapshotCandles(parsed.data),
      markets: await candleRepository.getInventory({ limit: 100 }),
    };
  });

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
    await updateAdminSettings({ moralisOhlcvEnabled: parsed.data.enabled });

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

function toSettingsPatch(value: z.infer<typeof settingsPatchSchema>): AdminSettingsPatch {
  const patch: AdminSettingsPatch = {};

  if (value.moralisOhlcvEnabled !== undefined) patch.moralisOhlcvEnabled = value.moralisOhlcvEnabled;
  if (value.moralisDailyCuBudget !== undefined) patch.moralisDailyCuBudget = value.moralisDailyCuBudget;
  if (value.maxSyncMoralisPages !== undefined) patch.maxSyncMoralisPages = value.maxSyncMoralisPages;
  if (value.maxSyncGapCandles !== undefined) patch.maxSyncGapCandles = value.maxSyncGapCandles;
  if (value.externalApiKeyRequestRateLimit !== undefined) {
    patch.externalApiKeyRequestRateLimit = value.externalApiKeyRequestRateLimit;
  }
  if (value.externalApiKeyCacheMissRateLimit !== undefined) {
    patch.externalApiKeyCacheMissRateLimit = value.externalApiKeyCacheMissRateLimit;
  }
  if (value.externalApiKeyDailyCuBudget !== undefined) {
    patch.externalApiKeyDailyCuBudget = value.externalApiKeyDailyCuBudget;
  }

  return patch;
}
