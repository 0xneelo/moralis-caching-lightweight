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

    await transaction(async (client) => {
      for (const candle of params.candles) {
        await upsertOne(client, params, candle);
      }
    });

    return { inserted: params.candles.length };
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
  await client.query(upsertCandleSql, [
    params.chain,
    params.pairAddress,
    params.timeframe,
    params.currency,
    new Date(candle.timestamp),
    candle.open,
    candle.high,
    candle.low,
    candle.close,
    candle.volume ?? null,
    candle.trades ?? null,
  ]);
}
