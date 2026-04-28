import net from 'node:net';
import { Redis } from 'ioredis';
import { config } from './config.js';
import { logger } from './logger.js';

const reportedRedisErrors = new Set<string>();

export const redis = attachRedisErrorHandler(
  new Redis(config.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  }),
  'app'
);

export function createQueueRedisConnection(name = 'queue') {
  return attachRedisErrorHandler(
    new Redis(config.REDIS_URL, {
      lazyConnect: true,
      retryStrategy: () => null,
      // BullMQ requires null here for blocking connections.
      maxRetriesPerRequest: null,
    }),
    name
  );
}

export async function assertRedisAvailable() {
  try {
    await pingRedisTcp(config.REDIS_URL);
  } catch (error) {
    logger.error(
      {
        error,
        redisUrl: sanitizeRedisUrl(config.REDIS_URL),
      },
      'Redis is not reachable. Start Redis or update REDIS_URL before running the API/worker.'
    );

    throw error;
  }
}

export async function closeRedis() {
  if (redis.status !== 'end') {
    await redis.quit().catch(() => redis.disconnect());
  }
}

function attachRedisErrorHandler(client: Redis, name: string) {
  client.on('error', (error) => {
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : 'UNKNOWN';
    const key = `${name}:${code}`;

    if (reportedRedisErrors.has(key)) {
      return;
    }

    reportedRedisErrors.add(key);
    logger.error(
      {
        error,
        redisUrl: sanitizeRedisUrl(config.REDIS_URL),
        connection: name,
      },
      'Redis connection error'
    );
  });

  return client;
}

function sanitizeRedisUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.password) {
      url.password = '***';
    }
    return url.toString();
  } catch {
    return value;
  }
}

function pingRedisTcp(redisUrl: string) {
  const url = new URL(redisUrl);
  const host = url.hostname || '127.0.0.1';
  const port = Number(url.port || 6379);

  return new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host, port });

    socket.setTimeout(2000);

    socket.once('connect', () => {
      socket.end();
      resolve();
    });

    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`Timed out connecting to Redis at ${host}:${port}`));
    });

    socket.once('error', reject);
  });
}
