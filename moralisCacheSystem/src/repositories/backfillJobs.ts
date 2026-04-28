import crypto from 'node:crypto';
import { query } from '../db.js';
import type { BackfillJobPayload } from '../types.js';

export const backfillJobRepository = {
  async create(params: Omit<BackfillJobPayload, 'dbJobId'>) {
    const generatedId = crypto.randomUUID();
    const result = await query<{ id: string }>(
      `
      INSERT INTO ohlcv_backfill_jobs (
        generatedId,
        chain,
        pair_address,
        timeframe,
        currency,
        from_ts,
        to_ts,
        priority,
        reason
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING id
      `,
      [
        generatedId,
        params.chain,
        params.pairAddress,
        params.timeframe,
        params.currency,
        new Date(params.from),
        new Date(params.to),
        params.priority,
        params.reason,
      ]
    );

    const createdId = result.rows[0]?.id;
    if (!createdId) {
      throw new Error('Failed to create backfill job');
    }

    return createdId;
  },

  async setQueueJobId(params: {
    dbJobId: string;
    queueJobId: string;
  }) {
    await query(
      'UPDATE ohlcv_backfill_jobs SET queue_job_id = $2 WHERE id = $1',
      [params.dbJobId, params.queueJobId]
    );
  },

  async markStarted(dbJobId: string) {
    await query(
      `
      UPDATE ohlcv_backfill_jobs
      SET status = 'running', started_at = now()
      WHERE id = $1
      `,
      [dbJobId]
    );
  },

  async markCompleted(params: {
    dbJobId: string;
    pagesFetched: number;
    candlesInserted: number;
  }) {
    await query(
      `
      UPDATE ohlcv_backfill_jobs
      SET status = 'completed',
          finished_at = now(),
          pages_fetched = $2,
          candles_inserted = $3
      WHERE id = $1
      `,
      [params.dbJobId, params.pagesFetched, params.candlesInserted]
    );
  },

  async markFailed(params: {
    dbJobId: string;
    errorMessage: string;
  }) {
    await query(
      `
      UPDATE ohlcv_backfill_jobs
      SET status = 'failed',
          finished_at = now(),
          error_message = $2
      WHERE id = $1
      `,
      [params.dbJobId, params.errorMessage]
    );
  },
};
