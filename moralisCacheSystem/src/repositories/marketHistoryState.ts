import { query } from '../db.js';
import type { MoralisCandle, OhlcvCurrency, OhlcvTimeframe } from '../types.js';

export type FullHistoryStatus = 'unknown' | 'queued' | 'running' | 'complete' | 'failed';

export type MarketHistoryState = {
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  historyFloorTs: Date;
  marketStartTs: Date | null;
  latestSyncedTs: Date | null;
  fullHistoryStatus: FullHistoryStatus;
  fullHistoryJobId: string | null;
  fullHistoryRequestedAt: Date | null;
  fullHistoryCompletedAt: Date | null;
  fullHistoryError: string | null;
  updatedAt: Date;
};

export const marketHistoryStateRepository = {
  async get(params: {
    chain: string;
    pairAddress: string;
    timeframe: OhlcvTimeframe;
    currency: OhlcvCurrency;
  }): Promise<MarketHistoryState | null> {
    const result = await query<{
      chain: string;
      pair_address: string;
      timeframe: OhlcvTimeframe;
      currency: OhlcvCurrency;
      history_floor_ts: Date;
      market_start_ts: Date | null;
      latest_synced_ts: Date | null;
      full_history_status: FullHistoryStatus;
      full_history_job_id: string | null;
      full_history_requested_at: Date | null;
      full_history_completed_at: Date | null;
      full_history_error: string | null;
      updated_at: Date;
    }>(
      `
      SELECT
        chain,
        pair_address,
        timeframe,
        currency,
        history_floor_ts,
        market_start_ts,
        latest_synced_ts,
        full_history_status,
        full_history_job_id,
        full_history_requested_at,
        full_history_completed_at,
        full_history_error,
        updated_at
      FROM market_history_state
      WHERE chain = $1
        AND pair_address = $2
        AND timeframe = $3
        AND currency = $4
      `,
      [params.chain, params.pairAddress, params.timeframe, params.currency]
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      chain: row.chain,
      pairAddress: row.pair_address,
      timeframe: row.timeframe,
      currency: row.currency,
      historyFloorTs: row.history_floor_ts,
      marketStartTs: row.market_start_ts,
      latestSyncedTs: row.latest_synced_ts,
      fullHistoryStatus: row.full_history_status,
      fullHistoryJobId: row.full_history_job_id,
      fullHistoryRequestedAt: row.full_history_requested_at,
      fullHistoryCompletedAt: row.full_history_completed_at,
      fullHistoryError: row.full_history_error,
      updatedAt: row.updated_at,
    };
  },

  async markQueued(params: {
    chain: string;
    pairAddress: string;
    timeframe: OhlcvTimeframe;
    currency: OhlcvCurrency;
    historyFloorTs: Date;
    queueJobId: string;
  }) {
    await query(
      `
      INSERT INTO market_history_state (
        chain,
        pair_address,
        timeframe,
        currency,
        history_floor_ts,
        full_history_status,
        full_history_job_id,
        full_history_requested_at,
        full_history_error,
        updated_at
      ) VALUES ($1,$2,$3,$4,$5,'queued',$6,now(),NULL,now())
      ON CONFLICT (chain, pair_address, timeframe, currency)
      DO UPDATE SET
        history_floor_ts = EXCLUDED.history_floor_ts,
        full_history_status = 'queued',
        full_history_job_id = EXCLUDED.full_history_job_id,
        full_history_requested_at = now(),
        full_history_error = NULL,
        updated_at = now()
      `,
      [
        params.chain,
        params.pairAddress,
        params.timeframe,
        params.currency,
        params.historyFloorTs,
        params.queueJobId,
      ]
    );
  },

  async markRunning(params: {
    chain: string;
    pairAddress: string;
    timeframe: OhlcvTimeframe;
    currency: OhlcvCurrency;
  }) {
    await query(
      `
      INSERT INTO market_history_state (
        chain,
        pair_address,
        timeframe,
        currency,
        history_floor_ts,
        full_history_status,
        updated_at
      ) VALUES ($1,$2,$3,$4,$5,'running',now())
      ON CONFLICT (chain, pair_address, timeframe, currency)
      DO UPDATE SET
        full_history_status = 'running',
        full_history_error = NULL,
        updated_at = now()
      `,
      [params.chain, params.pairAddress, params.timeframe, params.currency, new Date('2024-01-01T00:00:00.000Z')]
    );
  },

  async markCompleted(params: {
    chain: string;
    pairAddress: string;
    timeframe: OhlcvTimeframe;
    currency: OhlcvCurrency;
    marketStartTs: Date | null;
    latestSyncedTs: Date | null;
  }) {
    await query(
      `
      INSERT INTO market_history_state (
        chain,
        pair_address,
        timeframe,
        currency,
        history_floor_ts,
        market_start_ts,
        latest_synced_ts,
        full_history_status,
        full_history_completed_at,
        full_history_error,
        updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,'complete',now(),NULL,now())
      ON CONFLICT (chain, pair_address, timeframe, currency)
      DO UPDATE SET
        market_start_ts = EXCLUDED.market_start_ts,
        latest_synced_ts = EXCLUDED.latest_synced_ts,
        full_history_status = 'complete',
        full_history_completed_at = now(),
        full_history_error = NULL,
        updated_at = now()
      `,
      [
        params.chain,
        params.pairAddress,
        params.timeframe,
        params.currency,
        new Date('2024-01-01T00:00:00.000Z'),
        params.marketStartTs,
        params.latestSyncedTs,
      ]
    );
  },

  async markFailed(params: {
    chain: string;
    pairAddress: string;
    timeframe: OhlcvTimeframe;
    currency: OhlcvCurrency;
    errorMessage: string;
  }) {
    await query(
      `
      INSERT INTO market_history_state (
        chain,
        pair_address,
        timeframe,
        currency,
        history_floor_ts,
        full_history_status,
        full_history_error,
        updated_at
      ) VALUES ($1,$2,$3,$4,$5,'failed',$6,now())
      ON CONFLICT (chain, pair_address, timeframe, currency)
      DO UPDATE SET
        full_history_status = 'failed',
        full_history_error = EXCLUDED.full_history_error,
        updated_at = now()
      `,
      [
        params.chain,
        params.pairAddress,
        params.timeframe,
        params.currency,
        new Date('2024-01-01T00:00:00.000Z'),
        params.errorMessage,
      ]
    );
  },

  async upsertBoundsFromCandles(params: {
    chain: string;
    pairAddress: string;
    timeframe: OhlcvTimeframe;
    currency: OhlcvCurrency;
    candles: MoralisCandle[];
  }) {
    if (params.candles.length === 0) {
      return;
    }

    let minTimestamp: Date | null = null;
    let maxTimestamp: Date | null = null;

    for (const candle of params.candles) {
      const timestamp = new Date(candle.timestamp);
      if (Number.isNaN(timestamp.getTime())) {
        continue;
      }

      if (!minTimestamp || timestamp < minTimestamp) {
        minTimestamp = timestamp;
      }

      if (!maxTimestamp || timestamp > maxTimestamp) {
        maxTimestamp = timestamp;
      }
    }

    if (!minTimestamp || !maxTimestamp) {
      return;
    }

    await query(
      `
      INSERT INTO market_history_state (
        chain,
        pair_address,
        timeframe,
        currency,
        history_floor_ts,
        market_start_ts,
        latest_synced_ts,
        updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,now())
      ON CONFLICT (chain, pair_address, timeframe, currency)
      DO UPDATE SET
        market_start_ts = CASE
          WHEN market_history_state.market_start_ts IS NULL THEN EXCLUDED.market_start_ts
          ELSE LEAST(market_history_state.market_start_ts, EXCLUDED.market_start_ts)
        END,
        latest_synced_ts = CASE
          WHEN market_history_state.latest_synced_ts IS NULL THEN EXCLUDED.latest_synced_ts
          ELSE GREATEST(market_history_state.latest_synced_ts, EXCLUDED.latest_synced_ts)
        END,
        updated_at = now()
      `,
      [
        params.chain,
        params.pairAddress,
        params.timeframe,
        params.currency,
        new Date('2024-01-01T00:00:00.000Z'),
        minTimestamp,
        maxTimestamp,
      ]
    );
  },
};
