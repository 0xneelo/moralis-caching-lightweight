import type { PoolClient } from 'pg';
import { CACHE_SNAPSHOT_FORMAT, type CacheSnapshot } from '../cacheSnapshot.js';
import { query, transaction } from '../db.js';
import type { MoralisCandle, OhlcvCurrency, OhlcvTimeframe, StoredCandle } from '../types.js';

const upsertCandleSql = `
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
  trades,
  source,
  updated_at
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'moralis', now()
)
ON CONFLICT (chain, pair_address, timeframe, currency, timestamp)
DO UPDATE SET
  open = EXCLUDED.open,
  high = EXCLUDED.high,
  low = EXCLUDED.low,
  close = EXCLUDED.close,
  volume = EXCLUDED.volume,
  trades = EXCLUDED.trades,
  source = EXCLUDED.source,
  updated_at = now()
`;

export const candleRepository = {
  async findCandles(params: {
    chain: string;
    pairAddress: string;
    timeframe: OhlcvTimeframe;
    currency: OhlcvCurrency;
    from: Date;
    to: Date;
  }) {
    const result = await query<StoredCandle>(
      `
      SELECT timestamp, open, high, low, close, volume, trades
      FROM ohlcv_candles
      WHERE chain = $1
        AND pair_address = $2
        AND timeframe = $3
        AND currency = $4
        AND timestamp >= $5
        AND timestamp <= $6
      ORDER BY timestamp ASC
      `,
      [
        params.chain,
        params.pairAddress,
        params.timeframe,
        params.currency,
        params.from,
        params.to,
      ]
    );

    return result.rows;
  },

  async upsertCandles(params: {
    chain: string;
    pairAddress: string;
    timeframe: OhlcvTimeframe;
    currency: OhlcvCurrency;
    candles: MoralisCandle[];
  }) {
    if (params.candles.length === 0) {
      return { inserted: 0 };
    }

    const chunkSize = 500;

    for (let offset = 0; offset < params.candles.length; offset += chunkSize) {
      const chunk = params.candles.slice(offset, offset + chunkSize);
      const values: unknown[] = [];
      const placeholders = chunk.map((candle, index) => {
        const normalized = normalizeMoralisCandle(candle);
        const base = index * 11;
        values.push(
          params.chain,
          params.pairAddress,
          params.timeframe,
          params.currency,
          new Date(normalized.timestamp),
          normalized.open,
          normalized.high,
          normalized.low,
          normalized.close,
          normalized.volume ?? null,
          normalized.trades ?? null
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, 'moralis', now())`;
      });

      await query(
        `
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
          trades,
          source,
          updated_at
        ) VALUES ${placeholders.join(',')}
        ON CONFLICT (chain, pair_address, timeframe, currency, timestamp)
        DO UPDATE SET
          open = EXCLUDED.open,
          high = EXCLUDED.high,
          low = EXCLUDED.low,
          close = EXCLUDED.close,
          volume = EXCLUDED.volume,
          trades = EXCLUDED.trades,
          source = EXCLUDED.source,
          updated_at = now()
        `,
        values
      );
    }

    return { inserted: params.candles.length };
  },

  async getBounds(params: {
    chain: string;
    pairAddress: string;
    timeframe: OhlcvTimeframe;
    currency: OhlcvCurrency;
  }) {
    const result = await query<{
      min_timestamp: Date | null;
      max_timestamp: Date | null;
    }>(
      `
      SELECT
        MIN(timestamp) AS min_timestamp,
        MAX(timestamp) AS max_timestamp
      FROM ohlcv_candles
      WHERE chain = $1
        AND pair_address = $2
        AND timeframe = $3
        AND currency = $4
      `,
      [params.chain, params.pairAddress, params.timeframe, params.currency]
    );

    const row = result.rows[0];
    return {
      minTimestamp: row?.min_timestamp ?? null,
      maxTimestamp: row?.max_timestamp ?? null,
    };
  },

  async findCandlesPageDesc(params: {
    chain: string;
    pairAddress: string;
    timeframe: OhlcvTimeframe;
    currency: OhlcvCurrency;
    from: Date;
    to: Date;
    before?: Date | undefined;
    limit: number;
  }) {
    const limit = Math.max(1, Math.min(1001, params.limit));
    const result = await query<StoredCandle>(
      `
      SELECT timestamp, open, high, low, close, volume, trades
      FROM ohlcv_candles
      WHERE chain = $1
        AND pair_address = $2
        AND timeframe = $3
        AND currency = $4
        AND timestamp >= $5
        AND timestamp <= $6
        AND ($7::timestamptz IS NULL OR timestamp < $7)
      ORDER BY timestamp DESC
      LIMIT $8
      `,
      [
        params.chain,
        params.pairAddress,
        params.timeframe,
        params.currency,
        params.from,
        params.to,
        params.before ?? null,
        limit,
      ]
    );

    return result.rows;
  },

  async findCountbackCandles(params: {
    chain: string;
    pairAddress: string;
    timeframe: OhlcvTimeframe;
    currency: OhlcvCurrency;
    to: Date;
    countBack: number;
  }) {
    const limit = Math.max(1, Math.min(1000, params.countBack));
    const result = await query<StoredCandle>(
      `
      SELECT timestamp, open, high, low, close, volume, trades
      FROM (
        SELECT timestamp, open, high, low, close, volume, trades
        FROM ohlcv_candles
        WHERE chain = $1
          AND pair_address = $2
          AND timeframe = $3
          AND currency = $4
          AND timestamp <= $5
          AND COALESCE(volume, 0) > 0
        ORDER BY timestamp DESC
        LIMIT $6
      ) latest
      ORDER BY timestamp ASC
      `,
      [
        params.chain,
        params.pairAddress,
        params.timeframe,
        params.currency,
        params.to,
        limit,
      ]
    );

    return result.rows;
  },

  async getInventory(params?: { limit?: number | undefined }) {
    const limit = Math.max(1, Math.min(500, params?.limit ?? 100));
    const result = await query<{
      chain: string;
      pair_address: string;
      timeframe: OhlcvTimeframe;
      currency: OhlcvCurrency;
      candle_count: string;
      first_candle_at: Date | null;
      last_candle_at: Date | null;
      updated_at: Date | null;
    }>(
      `
      SELECT
        chain,
        pair_address,
        timeframe,
        currency,
        count(*)::text AS candle_count,
        min(timestamp) AS first_candle_at,
        max(timestamp) AS last_candle_at,
        max(updated_at) AS updated_at
      FROM ohlcv_candles
      GROUP BY chain, pair_address, timeframe, currency
      ORDER BY max(updated_at) DESC
      LIMIT $1
      `,
      [limit]
    );

    return result.rows.map((row) => ({
      chain: row.chain,
      pairAddress: row.pair_address,
      timeframe: row.timeframe,
      currency: row.currency,
      candleCount: Number(row.candle_count),
      firstCandleAt: row.first_candle_at?.toISOString() ?? null,
      lastCandleAt: row.last_candle_at?.toISOString() ?? null,
      updatedAt: row.updated_at?.toISOString() ?? null,
    }));
  },

  async exportSnapshot(sourceRuntimeMode: string): Promise<CacheSnapshot> {
    const result = await query<{
      chain: string;
      pair_address: string;
      timeframe: OhlcvTimeframe;
      currency: OhlcvCurrency;
      timestamp: Date;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string | null;
      trades: number | null;
    }>(
      `
      SELECT
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
      FROM ohlcv_candles
      ORDER BY chain, pair_address, timeframe, currency, timestamp ASC
      `
    );

    const markets = new Map<string, CacheSnapshot['markets'][number]>();

    for (const row of result.rows) {
      const key = [row.chain, row.pair_address, row.timeframe, row.currency].join(':');
      const market =
        markets.get(key) ??
        {
          chain: row.chain,
          pairAddress: row.pair_address,
          timeframe: row.timeframe,
          currency: row.currency,
          candles: [],
        };

      market.candles.push({
        timestamp: row.timestamp.toISOString(),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        ...(row.volume !== null ? { volume: Number(row.volume) } : {}),
        ...(row.trades !== null ? { trades: row.trades } : {}),
      });
      markets.set(key, market);
    }

    return {
      format: CACHE_SNAPSHOT_FORMAT,
      exportedAt: new Date().toISOString(),
      sourceRuntimeMode,
      markets: [...markets.values()],
    };
  },

  async importSnapshot(snapshot: CacheSnapshot) {
    let importedCandles = 0;

    for (const market of snapshot.markets) {
      const result = await this.upsertCandles({
        chain: market.chain,
        pairAddress: market.pairAddress,
        timeframe: market.timeframe,
        currency: market.currency,
        candles: market.candles.map(toMoralisCandle),
      });

      importedCandles += result.inserted;
    }

    return {
      importedMarkets: snapshot.markets.length,
      importedCandles,
    };
  },
};

async function upsertOne(
  client: PoolClient,
  params: {
    chain: string;
    pairAddress: string;
    timeframe: OhlcvTimeframe;
    currency: OhlcvCurrency;
  },
  candle: MoralisCandle
) {
  const normalized = normalizeMoralisCandle(candle);

  await client.query(upsertCandleSql, [
    params.chain,
    params.pairAddress,
    params.timeframe,
    params.currency,
    new Date(normalized.timestamp),
    normalized.open,
    normalized.high,
    normalized.low,
    normalized.close,
    normalized.volume ?? null,
    normalized.trades ?? null,
  ]);
}

function normalizeMoralisCandle(candle: MoralisCandle): MoralisCandle {
  const open = Number(candle.open);
  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);

  if (![open, high, low, close].every(Number.isFinite)) {
    return candle;
  }

  const rangeHigh = Math.max(high, low);
  const rangeLow = Math.min(high, low);

  return {
    ...candle,
    open: clamp(open, rangeLow, rangeHigh),
    high: rangeHigh,
    low: rangeLow,
    close: clamp(close, rangeLow, rangeHigh),
  };
}

function toMoralisCandle(candle: CacheSnapshot['markets'][number]['candles'][number]): MoralisCandle {
  const result: MoralisCandle = {
    timestamp: candle.timestamp,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  };

  if (candle.volume !== undefined) {
    result.volume = candle.volume;
  }

  if (candle.trades !== undefined) {
    result.trades = candle.trades;
  }

  return result;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
