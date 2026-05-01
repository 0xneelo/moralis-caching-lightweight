import { backfillJobRepository } from '../repositories/backfillJobs.js';
import { normalizePairAddress } from '../pairAddress.js';
import type { BackfillJobPayload } from '../types.js';
import { getBackfillQueue } from './queue.js';

export async function enqueueBackfillJob(params: Omit<BackfillJobPayload, 'dbJobId'>) {
  const dbJobId = await backfillJobRepository.create(params);
  const job = await getBackfillQueue().add(
    'backfill',
    {
      ...params,
      dbJobId,
    },
    {
      priority: priorityToNumber(params.priority),
      jobId: dedupeJobId(params),
    }
  );

  await backfillJobRepository.setQueueJobId({
    dbJobId,
    queueJobId: String(job.id),
  });

  return { dbJobId, queueJobId: String(job.id) };
}

function priorityToNumber(priority: BackfillJobPayload['priority']) {
  switch (priority) {
    case 'high':
      return 1;
    case 'normal':
      return 5;
    case 'low':
      return 10;
  }
}

function dedupeJobId(params: Omit<BackfillJobPayload, 'dbJobId'>) {
  const pairAddress = normalizePairAddress(params.chain, params.pairAddress);

  return [
    'backfill',
    params.chain,
    pairAddress,
    params.timeframe,
    params.currency,
    params.from,
    params.to,
    params.reason,
  ].join(':');
}
