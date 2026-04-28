import type { FastifyInstance } from 'fastify';
import { providerUsageRepository } from '../repositories/providerUsage.js';

export async function registerUsageRoutes(app: FastifyInstance) {
  app.get('/api/usage/moralis', async () => providerUsageRepository.getSummary());
}
