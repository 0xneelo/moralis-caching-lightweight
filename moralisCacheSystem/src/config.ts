import dotenv from 'dotenv';
import fs from 'node:fs';
import { z } from 'zod';

dotenv.config();
loadRawMoralisKeyIfPresent();

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.string().default('info'),
  LOG_FILE: z.string().default('logs/app.log'),
  MORALIS_API_KEY: z.string().default(''),
  MORALIS_DAILY_CU_BUDGET: z.coerce.number().int().positive().default(5_000_000),
  DATABASE_URL: z.string().url().default('postgres://postgres:postgres@localhost:5432/moralis_cache'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  CHART_PROVIDER_ENABLED: z.coerce.boolean().default(true),
  MAX_SYNC_MORALIS_PAGES: z.coerce.number().int().positive().default(3),
  MAX_SYNC_GAP_CANDLES: z.coerce.number().int().positive().default(3000),
  DEFAULT_CURRENCY: z.enum(['usd', 'native']).default('usd'),
  ADMIN_API_KEY: z.string().optional(),
});

export const config = configSchema.parse(process.env);

export type AppConfig = typeof config;

function loadRawMoralisKeyIfPresent() {
  if (process.env.MORALIS_API_KEY) {
    return;
  }

  if (!fs.existsSync('.env')) {
    return;
  }

  const firstMeaningfulLine = fs
    .readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'));

  if (firstMeaningfulLine && !firstMeaningfulLine.includes('=')) {
    process.env.MORALIS_API_KEY = firstMeaningfulLine;
  }
}
