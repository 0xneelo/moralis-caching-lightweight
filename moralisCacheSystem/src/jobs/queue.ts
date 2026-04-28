import { Queue } from 'bullmq';
import { createQueueRedisConnection } from '../redis.js';
import type { BackfillJobPayload } from '../types.js';

export const backfillQueueName = 'ohlcv-backfill';

let backfillQueue: Queue<BackfillJobPayload> | undefined;

export function getBackfillQueue() {
  backfillQueue ??= new Queue<BackfillJobPayload>(backfillQueueName, {
    connection: createQueueRedisConnection('backfill-queue'),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 10_000,
      },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });

  return backfillQueue;
}

export async function closeQueues() {
  if (backfillQueue) {
    await backfillQueue.close();
  }
}
