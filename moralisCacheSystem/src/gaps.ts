import { alignToCandleStart, timeframeSeconds } from './timeframes.js';
import type { OhlcvTimeframe, StoredCandle, TimeRange } from './types.js';

export function findMissingRanges(params: {
  candles: Pick<StoredCandle, 'timestamp'>[];
  timeframe: OhlcvTimeframe;
  from: Date;
  to: Date;
}): TimeRange[] {
  const stepMs = timeframeSeconds[params.timeframe] * 1000;
  const existing = new Set(
    params.candles.map((candle) =>
      alignToCandleStart(candle.timestamp, params.timeframe).getTime()
    )
  );

  const gaps: TimeRange[] = [];
  let gapStart: Date | null = null;

  for (
    let ts = alignToCandleStart(params.from, params.timeframe).getTime();
    ts < params.to.getTime();
    ts += stepMs
  ) {
    if (!existing.has(ts)) {
      gapStart ??= new Date(ts);
    } else if (gapStart) {
      gaps.push({ from: gapStart, to: new Date(ts) });
      gapStart = null;
    }
  }

  if (gapStart) {
    gaps.push({ from: gapStart, to: params.to });
  }

  return mergeNearbyRanges(gaps, stepMs);
}

function mergeNearbyRanges(ranges: TimeRange[], stepMs: number): TimeRange[] {
  const merged: TimeRange[] = [];

  for (const range of ranges) {
    const previous = merged.at(-1);

    if (previous && range.from.getTime() - previous.to.getTime() <= stepMs) {
      previous.to = range.to;
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}
