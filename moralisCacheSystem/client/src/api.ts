export type Timeframe =
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

export type ChartRange = '24H' | '7D' | '30D' | '3M' | '6M' | '1Y' | 'ALL';

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

export type ChartResponse = {
  chain: string;
  pairAddress: string;
  timeframe: Timeframe;
  currency: 'usd' | 'native';
  from: string;
  to: string;
  source: 'cache' | 'cache+moralis' | 'partial' | 'demo';
  partial: boolean;
  candles: ChartCandle[];
};

export type ChartRequest = {
  chain: string;
  pairAddress: string;
  timeframe: Timeframe;
  from: Date;
  to: Date;
};

export type MoralisUsage = {
  todayCu: number;
  totalCu: number;
  todayRequests: number;
  totalRequests: number;
  since: string;
  updatedAt: string;
};

export async function fetchChartCandles(params: ChartRequest) {
  const url = new URL('/api/charts/ohlcv', window.location.origin);
  url.searchParams.set('chain', params.chain);
  url.searchParams.set('pairAddress', params.pairAddress);
  url.searchParams.set('timeframe', params.timeframe);
  url.searchParams.set('currency', 'usd');
  url.searchParams.set('from', params.from.toISOString());
  url.searchParams.set('to', params.to.toISOString());

  const response = await fetch(url);

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `Chart request failed with ${response.status}`;
    throw new Error(message);
  }

  return (await response.json()) as ChartResponse;
}

export async function fetchMoralisUsage() {
  const response = await fetch('/api/usage/moralis');

  if (!response.ok) {
    throw new Error(`Usage request failed with ${response.status}`);
  }

  return (await response.json()) as MoralisUsage;
}

export function getRangeWindow(range: ChartRange) {
  const to = new Date();
  const dayMs = 24 * 60 * 60 * 1000;

  switch (range) {
    case '24H':
      return { from: new Date(to.getTime() - dayMs), to };
    case '7D':
      return { from: new Date(to.getTime() - 7 * dayMs), to };
    case '30D':
      return { from: new Date(to.getTime() - 30 * dayMs), to };
    case '3M':
      return { from: new Date(to.getTime() - 90 * dayMs), to };
    case '6M':
      return { from: new Date(to.getTime() - 180 * dayMs), to };
    case '1Y':
      return { from: new Date(to.getTime() - 365 * dayMs), to };
    case 'ALL':
      return { from: new Date('2024-01-01T00:00:00.000Z'), to };
  }
}

export function getSafeTimeframeForRange(range: ChartRange, current: Timeframe): Timeframe {
  const order: Timeframe[] = ['1min', '5min', '10min', '30min', '1h', '4h', '12h', '1d', '1w', '1M'];
  const minimum = getMinimumTimeframeForRange(range);
  return order.indexOf(current) < order.indexOf(minimum) ? minimum : current;
}

export function getMinimumTimeframeForRange(range: ChartRange): Timeframe {
  const minimumByRange: Record<ChartRange, Timeframe> = {
    '24H': '1min',
    '7D': '5min',
    '30D': '30min',
    '3M': '1h',
    '6M': '1h',
    '1Y': '4h',
    ALL: '1d',
  };

  return minimumByRange[range];
}

export function isTimeframeAllowedForRange(range: ChartRange, timeframe: Timeframe) {
  const order: Timeframe[] = ['1min', '5min', '10min', '30min', '1h', '4h', '12h', '1d', '1w', '1M'];
  const minimum = getMinimumTimeframeForRange(range);
  return order.indexOf(timeframe) >= order.indexOf(minimum);
}
