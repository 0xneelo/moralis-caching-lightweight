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

export function prioritizeVisibleRanges(
  ranges: TimeRange[],
  visibleRange: TimeRange
) {
  return [...ranges].sort((left, right) => {
    const leftVisible = rangesOverlap(left, visibleRange);
    const rightVisible = rangesOverlap(right, visibleRange);

    if (leftVisible !== rightVisible) {
      return leftVisible ? -1 : 1;
    }

    if (leftVisible && rightVisible) {
      const newestFirst = right.to.getTime() - left.to.getTime();
      if (newestFirst !== 0) {
        return newestFirst;
      }
    }

    return distanceToRange(left, visibleRange) - distanceToRange(right, visibleRange);
  });
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

function rangesOverlap(left: TimeRange, right: TimeRange) {
  return left.from < right.to && left.to > right.from;
}

function distanceToRange(range: TimeRange, target: TimeRange) {
  if (rangesOverlap(range, target)) {
    return 0;
  }

  if (range.to <= target.from) {
    return target.from.getTime() - range.to.getTime();
  }

  return range.from.getTime() - target.to.getTime();
}
