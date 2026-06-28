import { backfillJobRepository } from '../repositories/backfillJobs.js';
import { normalizePairAddress } from '../pairAddress.js';
import { getDefaultOhlcvProvider } from '../providers/ohlcv/registry.js';
import type { BackfillJobPayload } from '../types.js';
import { getBackfillQueue } from './queue.js';

export async function enqueueBackfillJob(params: Omit<BackfillJobPayload, 'dbJobId'>) {
  const payload = {
    ...params,
    provider: params.provider ?? getDefaultOhlcvProvider(),
  };
  const dbJobId = await backfillJobRepository.create(payload);
  const job = await getBackfillQueue().add(
    'backfill',
    {
      ...payload,
      dbJobId,
    },
    {
      priority: priorityToNumber(payload.priority),
      jobId: dedupeJobId(payload),
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

function dedupeJobId(params: Omit<BackfillJobPayload, 'dbJobId'> & { provider: NonNullable<BackfillJobPayload['provider']> }) {
  const pairAddress = normalizePairAddress(params.chain, params.pairAddress);

  return [
    'backfill',
    params.provider,
    params.chain,
    pairAddress,
    params.timeframe,
    params.currency,
    params.from,
    params.to,
    params.reason,
  ]
    .map((part) => part.replaceAll(':', '-'))
    .join('__');
}
