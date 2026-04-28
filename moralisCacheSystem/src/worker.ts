import { closeDb } from './db.js';
import { createBackfillWorker } from './jobs/backfillWorker.js';
import { closeQueues } from './jobs/queue.js';
import { logger } from './logger.js';
import { assertRedisAvailable, closeRedis } from './redis.js';

try {
  await assertRedisAvailable();
} catch {
  process.exit(1);
}

const worker = createBackfillWorker();

logger.info('Backfill worker started');

const shutdown = async () => {
  logger.info('Shutting down worker');
  await worker.close();
  await closeQueues();
  await closeRedis();
  await closeDb();
};

process.on('SIGINT', () => {
  void shutdown().then(() => process.exit(0));
});

process.on('SIGTERM', () => {
  void shutdown().then(() => process.exit(0));
});
