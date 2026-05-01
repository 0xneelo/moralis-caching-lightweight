import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { config } from './config.js';
import { HttpError } from './httpErrors.js';
import { registerAdminRoutes } from './routes/adminRoutes.js';
import { registerChartRoutes } from './routes/chartRoutes.js';
import { registerHealthRoutes } from './routes/healthRoutes.js';
import { registerInteractionRoutes } from './routes/interactionRoutes.js';
import { registerMoralisCompatRoutes } from './routes/moralisCompatRoutes.js';
import { registerUsageRoutes } from './routes/usageRoutes.js';

export async function buildServer() {
  const app = Fastify({
    logger:
      config.NODE_ENV === 'development'
        ? {
            level: config.LOG_LEVEL,
            transport: {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'SYS:standard',
              },
            },
          }
        : {
            level: config.LOG_LEVEL,
          },
    trustProxy: true,
  });

  await app.register(cors, {
    origin: true,
  });

  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
  });

  await registerHealthRoutes(app);
  await registerMoralisCompatRoutes(app);
  await registerChartRoutes(app);
  await registerUsageRoutes(app);
  await registerInteractionRoutes(app);
  await registerAdminRoutes(app);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      void reply.status(error.statusCode).send({
        error: error.message,
      });
      return;
    }

    request.log.error(error);
    void reply.status(500).send({
      error: 'Internal server error',
    });
  });

  return app;
}
