import crypto from 'node:crypto';
import { query } from '../db.js';
import type { OhlcvTimeframe } from '../types.js';

export const providerUsageRepository = {
  async log(params: {
    provider: string;
    endpoint: string;
    externalApiKeyId?: string;
    chain?: string;
    pairAddress?: string;
    timeframe?: OhlcvTimeframe;
    requestFrom?: Date;
    requestTo?: Date;
    httpStatus?: number;
    estimatedCu: number;
    pages: number;
    durationMs?: number;
  }) {
    await query(
      `
      INSERT INTO provider_api_usage (
        id,
        provider,
        endpoint,
        external_api_key_id,
        chain,
        pair_address,
        timeframe,
        request_from,
        request_to,
        http_status,
        estimated_cu,
        pages,
        duration_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      `,
      [
        crypto.randomUUID(),
        params.provider,
        params.endpoint,
        params.externalApiKeyId ?? null,
        params.chain ?? null,
        params.pairAddress ?? null,
        params.timeframe ?? null,
        params.requestFrom ?? null,
        params.requestTo ?? null,
        params.httpStatus ?? null,
        params.estimatedCu,
        params.pages,
        params.durationMs ?? null,
      ]
    );
  },

  async sumEstimatedCu(params: {
    provider: string;
    from: Date;
    to: Date;
    externalApiKeyId?: string;
  }) {
    const result = await query<{ total: string }>(
      `
      SELECT COALESCE(sum(estimated_cu), 0)::text AS total
      FROM provider_api_usage
      WHERE provider = $1
        AND created_at >= $2
        AND created_at < $3
        AND ($4::text IS NULL OR external_api_key_id = $4)
      `,
      [params.provider, params.from, params.to, params.externalApiKeyId ?? null]
    );

    return Number(result.rows[0]?.total ?? 0);
  },

  async getSummary() {
    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    const result = await query<{
      today_cu: string;
      total_cu: string;
      today_requests: string;
      total_requests: string;
    }>(
      `
      SELECT
        COALESCE(sum(estimated_cu) FILTER (WHERE created_at >= $1), 0)::text AS today_cu,
        COALESCE(sum(estimated_cu), 0)::text AS total_cu,
        COALESCE(count(*) FILTER (WHERE created_at >= $1), 0)::text AS today_requests,
        COALESCE(count(*), 0)::text AS total_requests
      FROM provider_api_usage
      WHERE provider = 'moralis'
        AND endpoint = 'getPairCandlesticks'
      `,
      [startOfDay]
    );

    const row = result.rows[0];

    return {
      todayCu: Number(row?.today_cu ?? 0),
      totalCu: Number(row?.total_cu ?? 0),
      todayRequests: Number(row?.today_requests ?? 0),
      totalRequests: Number(row?.total_requests ?? 0),
      since: startOfDay.toISOString(),
      updatedAt: now.toISOString(),
    };
  },

  async logThrottleEvent(params: {
    provider: string;
    reason: string;
    chain?: string;
    pairAddress?: string;
    timeframe?: OhlcvTimeframe;
    requestFrom?: Date;
    requestTo?: Date;
    detailMs?: number;
  }) {
    await query(
      `
      INSERT INTO provider_api_usage (
        id,
        provider,
        endpoint,
        chain,
        pair_address,
        timeframe,
        request_from,
        request_to,
        http_status,
        estimated_cu,
        pages,
        duration_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `,
      [
        crypto.randomUUID(),
        params.provider,
        `chartThrottle:${params.reason}`,
        params.chain ?? null,
        params.pairAddress ?? null,
        params.timeframe ?? null,
        params.requestFrom ?? null,
        params.requestTo ?? null,
        429,
        0,
        0,
        params.detailMs ?? null,
      ]
    );
  },

  async getThrottleEvents(params?: { limit?: number | undefined }) {
    const limit = Math.max(1, Math.min(1000, params?.limit ?? 200));
    const result = await query<{
      timestamp: Date;
      endpoint: string;
      chain: string | null;
      pair_address: string | null;
      timeframe: string | null;
      request_from: Date | null;
      request_to: Date | null;
      detail_ms: number | null;
    }>(
      `
      SELECT
        created_at AS timestamp,
        endpoint,
        chain,
        pair_address,
        timeframe,
        request_from,
        request_to,
        duration_ms AS detail_ms
      FROM provider_api_usage
      WHERE provider = 'moralis'
        AND endpoint LIKE 'chartThrottle:%'
      ORDER BY created_at DESC
      LIMIT $1
      `,
      [limit]
    );

    return result.rows.map((row) => ({
      timestamp: row.timestamp.toISOString(),
      reason: row.endpoint.replace(/^chartThrottle:/, ''),
      chain: row.chain,
      pairAddress: row.pair_address,
      timeframe: row.timeframe,
      requestFrom: row.request_from?.toISOString() ?? null,
      requestTo: row.request_to?.toISOString() ?? null,
      detailMs: row.detail_ms,
    }));
  },
};
