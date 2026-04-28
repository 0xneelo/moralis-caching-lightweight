import { query } from '../db.js';

export type ChartPair = {
  chain: string;
  pairAddress: string;
  isHot: boolean;
};

export const pairRepository = {
  async touchPair(params: {
    chain: string;
    pairAddress: string;
  }) {
    await query(
      `
      INSERT INTO chart_pairs (chain, pair_address, last_requested_at, request_count_24h)
      VALUES ($1, $2, now(), 1)
      ON CONFLICT (chain, pair_address)
      DO UPDATE SET
        last_requested_at = now(),
        request_count_24h = chart_pairs.request_count_24h + 1
      `,
      [params.chain, params.pairAddress]
    );
  },

  async findHotPairs(params: { limit: number }) {
    const result = await query<{
      chain: string;
      pair_address: string;
      is_hot: boolean;
    }>(
      `
      SELECT chain, pair_address, is_hot
      FROM chart_pairs
      WHERE is_active = TRUE
        AND is_hot = TRUE
      ORDER BY last_requested_at DESC NULLS LAST
      LIMIT $1
      `,
      [params.limit]
    );

    return result.rows.map((row) => ({
      chain: row.chain,
      pairAddress: row.pair_address,
      isHot: row.is_hot,
    }));
  },
};
