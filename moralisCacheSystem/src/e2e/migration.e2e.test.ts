import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, '../../migrations');

describe('migration E2E', () => {
  it('applies all SQL migrations and supports the core candle tables', async () => {
    const db = newDb({
      autoCreateForeignKeyIndices: true,
    });

    const migrations = (await fs.readdir(migrationsDir))
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const migration of migrations) {
      const sql = await fs.readFile(path.join(migrationsDir, migration), 'utf8');
      db.public.none(sql);
    }

    db.public.none(`
      INSERT INTO ohlcv_candles (
        chain,
        pair_address,
        timeframe,
        currency,
        timestamp,
        open,
        high,
        low,
        close,
        volume,
        trades
      ) VALUES (
        'eth',
        '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
        '1h',
        'usd',
        '2026-04-28T00:00:00.000Z',
        1,
        2,
        0.9,
        1.5,
        100,
        10
      )
    `);

    const candle = db.public.one(`
      SELECT chain, pair_address, timeframe, currency, close
      FROM ohlcv_candles
      WHERE chain = 'eth'
    `);

    expect(candle).toMatchObject({
      chain: 'eth',
      pair_address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      timeframe: '1h',
      currency: 'usd',
      close: 1.5,
    });

    const usage = db.public.many(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('ohlcv_candles', 'provider_api_usage', 'ohlcv_backfill_jobs', 'chart_pairs')
      ORDER BY table_name
    `);

    expect(usage.map((row) => row.table_name)).toEqual([
      'chart_pairs',
      'ohlcv_backfill_jobs',
      'ohlcv_candles',
      'provider_api_usage',
    ]);
  });
});
