import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb, query } from '../db.js';
import { logger } from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, '../../migrations');

try {
  await query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  `);

  const files = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const existing = await query('SELECT filename FROM schema_migrations WHERE filename = $1', [file]);

    if (existing.rowCount && existing.rowCount > 0) {
      logger.info({ file }, 'Migration already applied');
      continue;
    }

    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');

    await query(sql);
    await query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);

    logger.info({ file }, 'Migration applied');
  }

  await tryEnableTimescale();
} catch (error) {
  logger.error(
    {
      error,
    },
    'Migration failed. Ensure DATABASE_URL points to a running Postgres/TimescaleDB instance, then rerun npm run migrate.'
  );
  process.exitCode = 1;
} finally {
  await closeDb();
}

async function tryEnableTimescale() {
  try {
    await query('CREATE EXTENSION IF NOT EXISTS timescaledb');
    await query("SELECT create_hypertable('ohlcv_candles', 'timestamp', if_not_exists => TRUE)");
    logger.info('TimescaleDB hypertable enabled for ohlcv_candles');
  } catch (error) {
    logger.warn(
      { error },
      'TimescaleDB extension or hypertable setup unavailable. Continuing with plain Postgres tables.'
    );
  }
}
