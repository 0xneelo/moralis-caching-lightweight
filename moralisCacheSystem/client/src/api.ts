export type Timeframe =
  | '1min'
  | '5min'
  | '10min'
  | '30min'
  | '1h'
  | '4h'
  | '6h'
  | '12h'
  | '1d'
  | '1w'
  | '1M';

export type ChartRange =
  | '1H'
  | '3H'
  | '4H'
  | '6H'
  | '8H'
  | '12H'
  | '24H'
  | '48H'
  | '7D'
  | '30D'
  | '2M'
  | '3M'
  | '6M'
  | '1Y'
  | 'ALL';

export type TimeWindow = {
  from: Date;
  to: Date;
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
  source?: 'cache' | 'moralis' | 'demo' | 'filled';
};

export type ChartResponse = {
  chain: string;
  pairAddress: string;
  requestedTimeframe: Timeframe;
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
  effectiveTimeframe?: Timeframe | undefined;
  from: Date;
  to: Date;
  visibleFrom?: Date | undefined;
  visibleTo?: Date | undefined;
  signal?: AbortSignal;
  interactionId?: string | undefined;
};

export type MoralisUsage = {
  todayCu: number;
  totalCu: number;
  todayRequests: number;
  totalRequests: number;
  since: string;
  updatedAt: string;
};

export type PairMetadata = {
  label: string;
  baseSymbol?: string;
  quoteSymbol?: string;
  dexId?: string;
};

const timeframeSeconds: Record<Timeframe, number> = {
  '1min': 60,
  '5min': 5 * 60,
  '10min': 10 * 60,
  '30min': 30 * 60,
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
  '6h': 6 * 60 * 60,
  '12h': 12 * 60 * 60,
  '1d': 24 * 60 * 60,
  '1w': 7 * 24 * 60 * 60,
  '1M': 30 * 24 * 60 * 60,
};

const maxRequestCandlesByTimeframe: Record<Timeframe, number> = {
  '1min': 1500,
  '5min': 3000,
  '10min': 3000,
  '30min': 5000,
  '1h': 5000,
  '4h': 5000,
  '6h': 5000,
  '12h': 5000,
  '1d': 5000,
  '1w': 2000,
  '1M': 1000,
};

const MAX_CHART_REQUEST_CHUNKS = 5;
const adaptiveTimeframeOrder: Timeframe[] = ['1min', '5min', '10min', '30min', '1h', '4h', '6h', '12h', '1d'];

export async function fetchChartCandles(params: ChartRequest) {
  const effectiveTimeframe =
    params.effectiveTimeframe ??
    getEffectiveTimeframeForWindow(params.timeframe, {
      from: params.from,
      to: params.to,
    });
  const normalizedWindow = normalizeWindowForTimeframe(
    {
      from: params.from,
      to: params.to,
    },
    effectiveTimeframe
  );
  const effectiveParams = {
    ...params,
    ...normalizedWindow,
    requestedTimeframe: params.timeframe,
    timeframe: effectiveTimeframe,
  };
  const chunks = getRequestChunks(effectiveParams);

  if (chunks.length === 1) {
    return fetchChartCandlesOnce({ ...effectiveParams, ...chunks[0]! });
  }

  const responses: ChartResponse[] = [];

  for (const chunk of chunks) {
    responses.push(await fetchChartCandlesOnce({ ...effectiveParams, ...chunk }));
  }

  return mergeChartResponses(effectiveParams, responses);
}

export function getPrefetchWindow(visibleRange: TimeWindow, timeframe: Timeframe): TimeWindow {
  const maxPrefetchMs =
    maxRequestCandlesByTimeframe[timeframe] *
    timeframeSeconds[timeframe] *
    1000;
  const visibleSpanMs = Math.max(0, visibleRange.to.getTime() - visibleRange.from.getTime());
  const allHistoryFrom = new Date('2024-01-01T00:00:00.000Z');
  const oldestSafeFrom = new Date(visibleRange.to.getTime() - maxPrefetchMs);
  const prefetchFrom =
    visibleSpanMs > maxPrefetchMs
      ? oldestSafeFrom
      : new Date(Math.min(visibleRange.from.getTime(), oldestSafeFrom.getTime()));
  const from = new Date(Math.max(allHistoryFrom.getTime(), prefetchFrom.getTime()));

  return normalizeWindowForTimeframe({
    from,
    to: visibleRange.to,
  }, timeframe);
}

export function getEffectiveTimeframeForWindow(requestedTimeframe: Timeframe, range: TimeWindow): Timeframe {
  const requestedIndex = adaptiveTimeframeOrder.indexOf(requestedTimeframe);

  if (requestedIndex === -1) {
    return requestedTimeframe;
  }

  const minimum = getMinimumTimeframeForWindow(range);
  const minimumIndex = adaptiveTimeframeOrder.indexOf(minimum);

  return adaptiveTimeframeOrder[Math.max(requestedIndex, minimumIndex)] ?? requestedTimeframe;
}

async function fetchChartCandlesOnce(params: ChartRequest & { requestedTimeframe: Timeframe }) {
  const url = new URL('/api/charts/ohlcv', window.location.origin);
  url.searchParams.set('chain', params.chain);
  url.searchParams.set('pairAddress', params.pairAddress);
  url.searchParams.set('timeframe', params.timeframe);
  url.searchParams.set('requestedTimeframe', params.requestedTimeframe);
  url.searchParams.set('currency', 'usd');
  url.searchParams.set('from', params.from.toISOString());
  url.searchParams.set('to', params.to.toISOString());
  if (params.visibleFrom) {
    url.searchParams.set('visibleFrom', params.visibleFrom.toISOString());
  }
  if (params.visibleTo) {
    url.searchParams.set('visibleTo', params.visibleTo.toISOString());
  }

  const headers = params.interactionId ? { 'x-interaction-id': params.interactionId } : undefined;
  const response = await fetch(url, {
    ...(params.signal ? { signal: params.signal } : {}),
    ...(headers ? { headers } : {}),
  });

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

function getRequestChunks(params: ChartRequest): TimeWindow[] {
  const maxCandles = maxRequestCandlesByTimeframe[params.timeframe];
  const stepMs = timeframeSeconds[params.timeframe] * 1000;
  const maxWindowMs = maxCandles * stepMs;
  const chunks: TimeWindow[] = [];
  let from = params.from;

  while (from < params.to) {
    const to = new Date(Math.min(params.to.getTime(), from.getTime() + maxWindowMs));
    chunks.push({ from, to });
    from = to;
  }

  return chunks;
}

function normalizeWindowForTimeframe(range: TimeWindow, timeframe: Timeframe): TimeWindow {
  const stepMs = timeframeSeconds[timeframe] * 1000;
  const from = new Date(Math.floor(range.from.getTime() / stepMs) * stepMs);
  const to = new Date(Math.max(from.getTime() + stepMs, Math.floor(range.to.getTime() / stepMs) * stepMs));

  return { from, to };
}

function mergeChartResponses(
  params: ChartRequest & { requestedTimeframe: Timeframe },
  responses: ChartResponse[]
): ChartResponse {
  const candlesByTime = new Map<number, ChartCandle>();

  for (const response of responses) {
    for (const candle of response.candles) {
      candlesByTime.set(candle.time, candle);
    }
  }

  return {
    chain: params.chain,
    pairAddress: params.pairAddress,
    requestedTimeframe: params.requestedTimeframe,
    timeframe: params.timeframe,
    currency: 'usd',
    from: params.from.toISOString(),
    to: params.to.toISOString(),
    source: mergeSources(responses.map((response) => response.source)),
    partial: responses.some((response) => response.partial),
    candles: [...candlesByTime.values()].sort((a, b) => a.time - b.time),
  };
}

function mergeSources(sources: ChartResponse['source'][]): ChartResponse['source'] {
  if (sources.includes('demo')) return 'demo';
  if (sources.includes('partial')) return 'partial';
  if (sources.includes('cache+moralis')) return 'cache+moralis';
  return 'cache';
}

export async function fetchMoralisUsage() {
  const response = await fetch('/api/usage/moralis');

  if (!response.ok) {
    throw new Error(`Usage request failed with ${response.status}`);
  }

  return (await response.json()) as MoralisUsage;
}

export async function fetchPairMetadata(params: {
  chainSlug: string;
  pairAddress: string;
}) {
  const response = await fetch(
    `https://api.dexscreener.com/latest/dex/pairs/${params.chainSlug}/${params.pairAddress}`
  );

  if (!response.ok) {
    throw new Error(`Pair metadata request failed with ${response.status}`);
  }

  const data = (await response.json()) as {
    pair?: {
      dexId?: string;
      baseToken?: {
        symbol?: string;
      };
      quoteToken?: {
        symbol?: string;
      };
    };
  };

  const baseSymbol = data.pair?.baseToken?.symbol;
  const quoteSymbol = data.pair?.quoteToken?.symbol;

  if (!baseSymbol && !quoteSymbol) {
    throw new Error('Pair metadata response did not include token symbols');
  }

  const metadata: PairMetadata = {
    label: [baseSymbol, quoteSymbol].filter(Boolean).join(' / '),
  };

  if (baseSymbol) {
    metadata.baseSymbol = baseSymbol;
  }

  if (quoteSymbol) {
    metadata.quoteSymbol = quoteSymbol;
  }

  if (data.pair?.dexId) {
    metadata.dexId = data.pair.dexId;
  }

  return metadata;
}

export function getRangeWindow(range: ChartRange): TimeWindow {
  const to = new Date();
  const dayMs = 24 * 60 * 60 * 1000;

  switch (range) {
    case '1H':
      return { from: new Date(to.getTime() - 60 * 60 * 1000), to };
    case '3H':
      return { from: new Date(to.getTime() - 3 * 60 * 60 * 1000), to };
    case '4H':
      return { from: new Date(to.getTime() - 4 * 60 * 60 * 1000), to };
    case '6H':
      return { from: new Date(to.getTime() - 6 * 60 * 60 * 1000), to };
    case '8H':
      return { from: new Date(to.getTime() - 8 * 60 * 60 * 1000), to };
    case '12H':
      return { from: new Date(to.getTime() - 12 * 60 * 60 * 1000), to };
    case '24H':
      return { from: new Date(to.getTime() - dayMs), to };
    case '48H':
      return { from: new Date(to.getTime() - 2 * dayMs), to };
    case '7D':
      return { from: new Date(to.getTime() - 7 * dayMs), to };
    case '30D':
      return { from: new Date(to.getTime() - 30 * dayMs), to };
    case '2M':
      return { from: new Date(to.getTime() - 60 * dayMs), to };
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
  const order: Timeframe[] = ['1min', '5min', '10min', '30min', '1h', '4h', '6h', '12h', '1d', '1w', '1M'];
  const minimum = getMinimumTimeframeForRange(range);
  return order.indexOf(current) < order.indexOf(minimum) ? minimum : current;
}

function getMinimumTimeframeForWindow(range: TimeWindow): Timeframe {
  const spanMs = Math.max(0, range.to.getTime() - range.from.getTime());
  const dayMs = 24 * 60 * 60 * 1000;

  if (spanMs <= dayMs) return '1min';
  if (spanMs <= 7 * dayMs) return '5min';
  if (spanMs <= 30 * dayMs) return '30min';
  if (spanMs <= 90 * dayMs) return '1h';
  if (spanMs <= 365 * dayMs) return '4h';
  return '12h';
}

export function getMinimumTimeframeForRange(range: ChartRange): Timeframe {
  const minimumByRange: Record<ChartRange, Timeframe> = {
    '1H': '1min',
    '3H': '1min',
    '4H': '1min',
    '6H': '1min',
    '8H': '1min',
    '12H': '1min',
    '24H': '1min',
    '48H': '1h',
    '7D': '5min',
    '30D': '30min',
    '2M': '1h',
    '3M': '1h',
    '6M': '4h',
    '1Y': '4h',
    ALL: '12h',
  };

  return minimumByRange[range];
}

export function isTimeframeAllowedForRange(range: ChartRange, timeframe: Timeframe) {
  const order: Timeframe[] = ['1min', '5min', '10min', '30min', '1h', '4h', '6h', '12h', '1d', '1w', '1M'];
  const minimum = getMinimumTimeframeForRange(range);
  return order.indexOf(timeframe) >= order.indexOf(minimum);
}
