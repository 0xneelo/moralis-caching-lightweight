import { config } from './config.js';
import { redis } from './redis.js';

const SETTING_KEYS = {
  moralisOhlcvEnabled: 'admin:settings:moralis_ohlcv_enabled',
  moralisDailyCuBudget: 'admin:settings:moralis_daily_cu_budget',
  maxSyncMoralisPages: 'admin:settings:max_sync_moralis_pages',
  maxSyncGapCandles: 'admin:settings:max_sync_gap_candles',
  externalApiKeyRequestRateLimit: 'admin:settings:external_api_key_request_rate_limit',
  externalApiKeyCacheMissRateLimit: 'admin:settings:external_api_key_cache_miss_rate_limit',
  externalApiKeyDailyCuBudget: 'admin:settings:external_api_key_daily_cu_budget',
} as const;

export type AdminSettings = {
  moralisOhlcvEnabled: boolean;
  moralisDailyCuBudget: number;
  maxSyncMoralisPages: number;
  maxSyncGapCandles: number;
  externalApiKeyRequestRateLimit: number;
  externalApiKeyCacheMissRateLimit: number;
  externalApiKeyDailyCuBudget: number;
};

export type AdminSettingsPatch = Partial<AdminSettings>;

export async function getAdminSettings(): Promise<AdminSettings> {
  const values = await Promise.all(Object.values(SETTING_KEYS).map((key) => redis.get(key)));

  return {
    moralisOhlcvEnabled: parseBoolean(values[0] ?? null, config.CHART_PROVIDER_ENABLED),
    moralisDailyCuBudget: parsePositiveInt(values[1] ?? null, config.MORALIS_DAILY_CU_BUDGET),
    maxSyncMoralisPages: parsePositiveInt(values[2] ?? null, config.MAX_SYNC_MORALIS_PAGES),
    maxSyncGapCandles: parsePositiveInt(values[3] ?? null, config.MAX_SYNC_GAP_CANDLES),
    externalApiKeyRequestRateLimit: parsePositiveInt(
      values[4] ?? null,
      config.EXTERNAL_API_KEY_REQUEST_RATE_LIMIT
    ),
    externalApiKeyCacheMissRateLimit: parsePositiveInt(
      values[5] ?? null,
      config.EXTERNAL_API_KEY_CACHE_MISS_RATE_LIMIT
    ),
    externalApiKeyDailyCuBudget: parsePositiveInt(values[6] ?? null, config.EXTERNAL_API_KEY_DAILY_CU_BUDGET),
  };
}

export async function updateAdminSettings(patch: AdminSettingsPatch): Promise<AdminSettings> {
  const entries = Object.entries(patch) as [keyof AdminSettings, boolean | number][];

  for (const [key, value] of entries) {
    await redis.set(SETTING_KEYS[key], String(value));
  }

  return getAdminSettings();
}

function parsePositiveInt(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value: string | null, fallback: boolean) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}
