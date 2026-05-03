import type { MoralisCandle } from './types.js';

const DAILY_STEP_MS = 24 * 60 * 60 * 1000;
const SUSPICIOUS_STREAK_MIN_LENGTH = 5;
const SUSPICIOUS_MAX_BODY_RATIO = 0.02;
const SUSPICIOUS_MIN_RANGE_PCT = 0.15;

type CandleLike = {
  timestamp: string | Date;
  open: number;
  high: number;
  low: number;
  close: number;
};

export function normalizeCandleOhlc(candle: {
  open: number;
  high: number;
  low: number;
  close: number;
}) {
  const open = Number(candle.open);
  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);

  if (![open, high, low, close].every(Number.isFinite)) {
    return null;
  }

  const rangeHigh = Math.max(high, low);
  const rangeLow = Math.min(high, low);

  return {
    open: clamp(open, rangeLow, rangeHigh),
    high: rangeHigh,
    low: rangeLow,
    close: clamp(close, rangeLow, rangeHigh),
  };
}

export function normalizeMoralisCandle(candle: MoralisCandle): MoralisCandle {
  const normalized = normalizeCandleOhlc(candle);

  if (!normalized) {
    return candle;
  }

  return {
    ...candle,
    ...normalized,
  };
}

export function hasSuspiciousDailyPattern(candles: CandleLike[]) {
  return findSuspiciousDailyRanges(candles).length > 0;
}

export function findSuspiciousDailyRanges(candles: CandleLike[]) {
  return findSuspiciousOhlcRanges(candles, DAILY_STEP_MS);
}

export function findSuspiciousOhlcRanges(candles: CandleLike[], stepMs: number) {
  if (candles.length < SUSPICIOUS_STREAK_MIN_LENGTH) {
    return [] as Array<{ from: Date; to: Date }>;
  }

  const sorted = candles
    .map((candle) => {
      const normalized = normalizeCandleOhlc(candle);
      if (!normalized) {
        return null;
      }

      const timestampMs =
        candle.timestamp instanceof Date
          ? candle.timestamp.getTime()
          : new Date(candle.timestamp).getTime();

      if (!Number.isFinite(timestampMs)) {
        return null;
      }

      const range = normalized.high - normalized.low;
      const body = Math.abs(normalized.close - normalized.open);
      const midpoint = Math.max(1e-12, (normalized.open + normalized.close) / 2);
      const bodyRatio = range <= 0 ? 0 : body / range;
      const rangePct = range / midpoint;
      const pinnedToEdge =
        isNearlyEqual(normalized.open, normalized.low) ||
        isNearlyEqual(normalized.open, normalized.high) ||
        isNearlyEqual(normalized.close, normalized.low) ||
        isNearlyEqual(normalized.close, normalized.high);

      return {
        timestampMs,
        suspicious:
          range > 0 &&
          bodyRatio <= SUSPICIOUS_MAX_BODY_RATIO &&
          rangePct >= SUSPICIOUS_MIN_RANGE_PCT &&
          pinnedToEdge,
      };
    })
    .filter((item): item is { timestampMs: number; suspicious: boolean } => item !== null)
    .sort((left, right) => left.timestampMs - right.timestampMs);

  const suspiciousRanges: Array<{ from: Date; to: Date }> = [];
  let streakStart: number | null = null;
  let streakEnd: number | null = null;
  let streakLength = 0;

  for (const candle of sorted) {
    if (candle.suspicious) {
      if (streakEnd !== null && candle.timestampMs - streakEnd > stepMs * 1.5) {
        flushCurrentStreak();
      }

      if (streakStart === null) {
        streakStart = candle.timestampMs;
      }

      streakEnd = candle.timestampMs;
      streakLength += 1;
      continue;
    }

    flushCurrentStreak();
  }

  flushCurrentStreak();
  return suspiciousRanges;

  function flushCurrentStreak() {
    if (streakStart !== null && streakEnd !== null && streakLength >= SUSPICIOUS_STREAK_MIN_LENGTH) {
      suspiciousRanges.push({
        from: new Date(streakStart),
        to: new Date(streakEnd + stepMs),
      });
    }

    streakStart = null;
    streakEnd = null;
    streakLength = 0;
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function isNearlyEqual(left: number, right: number) {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= scale * 1e-12;
}
