export type OhlcvTimeframe =
  | '1s'
  | '10s'
  | '30s'
  | '1min'
  | '5min'
  | '10min'
  | '30min'
  | '1h'
  | '4h'
  | '12h'
  | '1d'
  | '1w'
  | '1M';

export type OhlcvCurrency = 'usd' | 'native';

export type StoredCandle = {
  timestamp: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string | null;
  trades: number | null;
};

export type MoralisCandle = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  trades?: number;
};

export type ChartCandle = {
  time: number;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  trades: number | null;
};

export type ChartOhlcvResponse = {
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  from: string;
  to: string;
  source: 'cache' | 'cache+moralis' | 'partial' | 'demo';
  partial: boolean;
  candles: ChartCandle[];
};

export type TimeRange = {
  from: Date;
  to: Date;
};

export type BackfillReason = 'admin' | 'user_gap' | 'active_refresh' | 'daily_gap_fill';

export type BackfillJobPayload = {
  dbJobId?: string;
  chain: string;
  pairAddress: string;
  timeframe: OhlcvTimeframe;
  currency: OhlcvCurrency;
  from: string;
  to: string;
  priority: 'low' | 'normal' | 'high';
  reason: BackfillReason;
};
