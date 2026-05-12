import { z } from 'zod';

export const CACHE_SNAPSHOT_FORMAT = 'moralis-cache-system-cache-v1';

const timeframeSchema = z.enum([
  '1s',
  '10s',
  '30s',
  '1min',
  '5min',
  '10min',
  '30min',
  '1h',
  '4h',
  '6h',
  '12h',
  '1d',
  '1w',
  '1M',
]);

export const cacheSnapshotSchema = z.object({
  format: z.literal(CACHE_SNAPSHOT_FORMAT),
  exportedAt: z.string().datetime(),
  sourceRuntimeMode: z.string(),
  markets: z.array(
    z.object({
      chain: z.string().min(1),
      pairAddress: z.string().min(1),
      timeframe: timeframeSchema,
      currency: z.enum(['usd', 'native']),
      candles: z.array(
        z.object({
          timestamp: z.string().datetime(),
          open: z.number(),
          high: z.number(),
          low: z.number(),
          close: z.number(),
          volume: z.number().optional(),
          trades: z.number().int().optional(),
        })
      ),
    })
  ),
});

export type CacheSnapshot = z.infer<typeof cacheSnapshotSchema>;

export function countSnapshotCandles(snapshot: CacheSnapshot) {
  return snapshot.markets.reduce((sum, market) => sum + market.candles.length, 0);
}
