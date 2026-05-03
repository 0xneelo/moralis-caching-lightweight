import type { PoolClient } from 'pg';
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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
