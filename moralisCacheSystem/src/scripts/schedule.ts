import { enqueueActivePairRefresh } from '../jobs/scheduler.js';
import { closeQueues } from '../jobs/queue.js';
import { closeRedis } from '../redis.js';
import { closeDb } from '../db.js';
import { logger } from '../logger.js';

const jobs = await enqueueActivePairRefresh();

logger.info({ count: jobs.length }, 'Active pair refresh jobs queued');

await closeQueues();
await closeRedis();
await closeDb();
