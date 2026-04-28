import { enqueueBackfillJob } from './enqueue.js';
import { pairRepository } from '../repositories/pairs.js';

export async function enqueueActivePairRefresh() {
  const pairs = await pairRepository.findHotPairs({ limit: 500 });
  const to = new Date();
  const from = new Date(to.getTime() - 2 * 60 * 60 * 1000);

  const jobs = [];

  for (const pair of pairs) {
    jobs.push(
      await enqueueBackfillJob({
        chain: pair.chain,
        pairAddress: pair.pairAddress.toLowerCase(),
        timeframe: '1min',
        currency: 'usd',
        from: from.toISOString(),
        to: to.toISOString(),
        priority: 'high',
        reason: 'active_refresh',
      })
    );
  }

  return jobs;
}
