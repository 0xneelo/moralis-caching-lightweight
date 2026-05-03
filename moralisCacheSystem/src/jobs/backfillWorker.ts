import { Worker } from 'bullmq';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { fetchMoralisOhlcv } from '../moralis.js';
import { normalizePairAddress } from '../pairAddress.js';
import { backfillJobRepository } from '../repositories/backfillJobs.js';
import { candleRepository } from '../repositories/candles.js';
import { marketHistoryStateRepository } from '../repositories/marketHistoryState.js';
import { providerUsageRepository } from '../repositories/providerUsage.js';
import { createQueueRedisConnection } from '../redis.js';
import type { BackfillJobPayload } from '../types.js';
import { backfillQueueName } from './queue.js';

export function createBackfillWorker() {
  const worker = new Worker<BackfillJobPayload>(
    backfillQueueName,
    async (job) => {
      const payload = job.data;
      const dbJobId = payload.dbJobId;
      const pairAddress = normalizePairAddress(payload.chain, payload.pairAddress);

      if (dbJobId) {
        await backfillJobRepository.markStarted(dbJobId);
      }
      if (payload.reason === 'initial_history_load') {
        await marketHistoryStateRepository.markRunning({
          chain: payload.chain,
          pairAddress,
          timeframe: payload.timeframe,
          currency: payload.currency,
        });
      }

      try {
        const result = await fetchMoralisOhlcv({
          chain: payload.chain,
          pairAddress,
          timeframe: payload.timeframe,
          currency: payload.currency,
          fromDate: new Date(payload.from),
          toDate: new Date(payload.to),
          maxPages: 100,
        });

        const upsertResult = await candleRepository.upsertCandles({
          chain: payload.chain,
          pairAddress,
          timeframe: payload.timeframe,
          currency: payload.currency,
          candles: result.candles,
        });
        await marketHistoryStateRepository.upsertBoundsFromCandles({
          chain: payload.chain,
          pairAddress,
          timeframe: payload.timeframe,
          currency: payload.currency,
          candles: result.candles,
        });

        await providerUsageRepository.log({
          provider: 'moralis',
          endpoint: 'getPairCandlesticks',
          chain: payload.chain,
          pairAddress,
          timeframe: payload.timeframe,
          requestFrom: new Date(payload.from),
          requestTo: new Date(payload.to),
          httpStatus: 200,
          estimatedCu: result.estimatedCu,
          pages: result.pages,
          durationMs: result.durationMs,
        });

        if (dbJobId) {
          await backfillJobRepository.markCompleted({
            dbJobId,
            pagesFetched: result.pages,
            candlesInserted: upsertResult.inserted,
          });
        }
        if (payload.reason === 'initial_history_load') {
          const bounds = await candleRepository.getBounds({
            chain: payload.chain,
            pairAddress,
            timeframe: payload.timeframe,
            currency: payload.currency,
          });

          if (!result.truncated) {
            await marketHistoryStateRepository.markCompleted({
              chain: payload.chain,
              pairAddress,
              timeframe: payload.timeframe,
              currency: payload.currency,
              marketStartTs: bounds.minTimestamp,
              latestSyncedTs: bounds.maxTimestamp,
            });
          } else {
            await marketHistoryStateRepository.markFailed({
              chain: payload.chain,
              pairAddress,
              timeframe: payload.timeframe,
              currency: payload.currency,
              errorMessage: 'Initial history load truncated before completion',
            });
          }
        }

        if (result.truncated) {
          logger.warn({ payload }, 'Backfill reached maxPages and may be incomplete');
        }
      } catch (error) {
        if (dbJobId) {
          await backfillJobRepository.markFailed({
            dbJobId,
            errorMessage: error instanceof Error ? error.message : 'Unknown error',
          });
        }
        if (payload.reason === 'initial_history_load') {
          await marketHistoryStateRepository.markFailed({
            chain: payload.chain,
            pairAddress,
            timeframe: payload.timeframe,
            currency: payload.currency,
            errorMessage: error instanceof Error ? error.message : 'Unknown error',
          });
        }

        throw error;
      }
    },
    {
      connection: createQueueRedisConnection('backfill-worker'),
      concurrency: config.NODE_ENV === 'production' ? 5 : 2,
    }
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'Backfill job completed');
  });

  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, error }, 'Backfill job failed');
  });

  return worker;
}
