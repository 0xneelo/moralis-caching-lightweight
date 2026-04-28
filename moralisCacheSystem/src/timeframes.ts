import type { OhlcvTimeframe } from './types.js';

export const supportedTimeframes = [
  '1s',
  '10s',
  '30s',
  '1min',
  '5min',
  '10min',
  '30min',
  '1h',
  '4h',
  '12h',
  '1d',
  '1w',
  '1M',
] as const;

export const timeframeSeconds: Record<OhlcvTimeframe, number> = {
  '1s': 1,
  '10s': 10,
  '30s': 30,
  '1min': 60,
  '5min': 5 * 60,
  '10min': 10 * 60,
  '30min': 30 * 60,
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
  '12h': 12 * 60 * 60,
  '1d': 24 * 60 * 60,
  '1w': 7 * 24 * 60 * 60,
  '1M': 30 * 24 * 60 * 60,
};

export const maxSyncCandlesByTimeframe: Record<OhlcvTimeframe, number> = {
  '1s': 300,
  '10s': 600,
  '30s': 1000,
  '1min': 1500,
  '5min': 3000,
  '10min': 3000,
  '30min': 5000,
  '1h': 5000,
  '4h': 5000,
  '12h': 5000,
  '1d': 5000,
  '1w': 2000,
  '1M': 1000,
};

export function isOhlcvTimeframe(value: string): value is OhlcvTimeframe {
  return supportedTimeframes.includes(value as OhlcvTimeframe);
}

export function estimateCandleCount(from: Date, to: Date, timeframe: OhlcvTimeframe) {
  const rangeSeconds = Math.max(0, (to.getTime() - from.getTime()) / 1000);
  return Math.ceil(rangeSeconds / timeframeSeconds[timeframe]);
}

export function alignToCandleStart(date: Date, timeframe: OhlcvTimeframe) {
  if (timeframe === '1M') {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  }

  const stepSeconds = timeframeSeconds[timeframe];
  const seconds = Math.floor(date.getTime() / 1000);
  const alignedSeconds = Math.floor(seconds / stepSeconds) * stepSeconds;
  return new Date(alignedSeconds * 1000);
}

export function assertChartRangeAllowed(params: {
  timeframe: OhlcvTimeframe;
  from: Date;
  to: Date;
}) {
  if (params.to <= params.from) {
    throw new Error('Invalid chart range');
  }

  const estimatedCandles = estimateCandleCount(params.from, params.to, params.timeframe);
  const maxCandles = maxSyncCandlesByTimeframe[params.timeframe];

  if (estimatedCandles > maxCandles) {
    throw new Error(
      `Requested range is too large for ${params.timeframe}. Estimated candles: ${estimatedCandles}, max: ${maxCandles}`
    );
  }
}
