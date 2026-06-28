import { config } from '../../config.js';
import type { OhlcvProviderId } from '../../types.js';
import { coingeckoOhlcvProvider } from './coingeckoProvider.js';
import { moralisOhlcvProvider } from './moralisProvider.js';
import type { OhlcvProvider } from './types.js';

const providers: Record<OhlcvProviderId, OhlcvProvider> = {
  moralis: moralisOhlcvProvider,
  coingecko: coingeckoOhlcvProvider,
};

export function parseOhlcvProvider(value: unknown): OhlcvProviderId | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === 'moralis' || normalized === 'coingecko' ? normalized : null;
}

export function getDefaultOhlcvProvider(): OhlcvProviderId {
  return config.OHLCV_DEFAULT_PROVIDER;
}

export function resolveOhlcvProvider(providerId: OhlcvProviderId): OhlcvProvider {
  return providers[providerId];
}

export function resolveRequestedOhlcvProvider(value: unknown): OhlcvProviderId {
  return parseOhlcvProvider(value) ?? getDefaultOhlcvProvider();
}
