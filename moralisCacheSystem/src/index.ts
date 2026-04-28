import { config } from './config.js';
import { closeDb } from './db.js';
import { logger } from './logger.js';
import { closeQueues } from './jobs/queue.js';
import { assertRedisAvailable, closeRedis } from './redis.js';
import { buildServer } from './server.js';

try {
  await assertRedisAvailable();
} catch {
  process.exit(1);
}

const app = await buildServer();

const shutdown = async () => {
  logger.info('Shutting down API server');
  await app.close();
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

await app.listen({
  port: config.PORT,
  host: '0.0.0.0',
});
