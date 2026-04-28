import type { FastifyInstance } from 'fastify';
import { query } from '../db.js';
import { redis } from '../redis.js';

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get('/health', async () => {
    await query('SELECT 1');
    await redis.ping();

    return {
      ok: true,
      service: 'moralis-cache-system',
      timestamp: new Date().toISOString(),
    };
  });
}
