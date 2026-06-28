import dotenv from 'dotenv';
import fs from 'node:fs';
import { z } from 'zod';

dotenv.config();
loadRawMoralisKeyIfPresent();

function booleanEnv(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined || value === '') {
      return undefined;
    }

    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes'].includes(normalized)) return true;
      if (['false', '0', 'no'].includes(normalized)) return false;
    }

    return value;
  }, z.boolean().default(defaultValue));
}

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.string().default('info'),
  LOG_FILE: z.string().default('logs/app.log'),
  MORALIS_LOG_FILE: z.string().default('logs/moralis.log'),
  INTERACTION_LOG_FILE: z.string().default('logs/interactions.log'),
  INTERACTION_LOG_DIR: z.string().default('logs/interactions'),
  MORALIS_API_KEY: z.string().default(''),
  MORALIS_DAILY_CU_BUDGET: z.coerce.number().int().positive().default(3_333_333),
  OHLCV_DEFAULT_PROVIDER: z.enum(['moralis', 'coingecko']).default('moralis'),
  COINGECKO_API_KEY: z.string().default(''),
  COINGECKO_API_BASE_URL: z.string().url().default('https://pro-api.coingecko.com/api/v3'),
  COINGECKO_DAILY_CREDIT_BUDGET: z.coerce.number().int().positive().default(100_000),
  COINGECKO_MAX_SYNC_PAGES: z.coerce.number().int().positive().default(8),
  COINGECKO_OHLCV_ENABLED: booleanEnv(true),
  DATABASE_URL: z.string().url().default('postgres://postgres:postgres@localhost:5432/moralis_cache'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  CHART_PROVIDER_ENABLED: z.coerce.boolean().default(true),
  MAX_SYNC_MORALIS_PAGES: z.coerce.number().int().positive().default(8),
  MAX_SYNC_GAP_CANDLES: z.coerce.number().int().positive().default(8000),
  EXTERNAL_API_KEY_REQUEST_RATE_LIMIT: z.coerce.number().int().positive().default(1200),
  EXTERNAL_API_KEY_CACHE_MISS_RATE_LIMIT: z.coerce.number().int().positive().default(60),
  EXTERNAL_API_KEY_DAILY_CU_BUDGET: z.coerce.number().int().positive().default(3_000_000),
  DEFAULT_CURRENCY: z.enum(['usd', 'native']).default('usd'),
  TUNNEL_MODE: z.coerce.boolean().default(false),
  ADMIN_API_KEY: z.string().optional(),
});

export const config = configSchema.parse(process.env);

if (config.NODE_ENV === 'production') {
  const missingProductionSecrets = [
    ['MORALIS_API_KEY', config.MORALIS_API_KEY],
    ['ADMIN_API_KEY', config.ADMIN_API_KEY],
    [
      'COINGECKO_API_KEY',
      config.OHLCV_DEFAULT_PROVIDER === 'coingecko' || config.COINGECKO_OHLCV_ENABLED
        ? config.COINGECKO_API_KEY
        : 'not-required',
    ],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missingProductionSecrets.length > 0) {
    throw new Error(`Missing required production env vars: ${missingProductionSecrets.join(', ')}`);
  }
}

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
