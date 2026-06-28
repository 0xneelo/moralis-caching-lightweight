import type { MoralisCandle, OhlcvCurrency, OhlcvProviderId, OhlcvTimeframe } from '../../types.js';

export type FetchOhlcvParams = {
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  fromDate: Date;
  toDate: Date;
  maxPages?: number;
  signal?: AbortSignal;
  interactionId?: string | undefined;
};

export type FetchOhlcvResult = {
  candles: MoralisCandle[];
  pages: number;
  estimatedCu: number;
  durationMs: number;
  truncated: boolean;
};

export type OhlcvProvider = {
  id: OhlcvProviderId;
  endpoint: string;
  fetchOhlcv(params: FetchOhlcvParams): Promise<FetchOhlcvResult>;
};
