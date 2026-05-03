import { describe, expect, it } from 'vitest';
import { findSuspiciousDailyRanges, normalizeCandleOhlc } from './candleQuality.js';

describe('candleQuality', () => {
  it('normalizes OHLC values into a valid range', () => {
    const normalized = normalizeCandleOhlc({
      open: 10,
      high: 8,
      low: 12,
      close: 9,
    });

    expect(normalized).toEqual({
      open: 10,
      high: 12,
      low: 8,
      close: 9,
    });
  });

  it('detects suspicious daily streaks with tiny bodies and huge ranges', () => {
    const candles = [
      { timestamp: '2025-11-23T00:00:00.000Z', open: 1, high: 1, low: 2, close: 1 },
      { timestamp: '2025-11-24T00:00:00.000Z', open: 1, high: 1.1, low: 2.2, close: 1.01 },
      { timestamp: '2025-11-25T00:00:00.000Z', open: 1, high: 1.05, low: 2.1, close: 1 },
      { timestamp: '2025-11-26T00:00:00.000Z', open: 1, high: 1, low: 2.3, close: 1 },
      { timestamp: '2025-11-27T00:00:00.000Z', open: 1, high: 1.2, low: 2.4, close: 1.02 },
      { timestamp: '2025-11-28T00:00:00.000Z', open: 1, high: 1.1, low: 2.2, close: 1 },
    ];

    const ranges = findSuspiciousDailyRanges(candles);
    expect(ranges).toEqual([
      {
        from: new Date('2025-11-23T00:00:00.000Z'),
        to: new Date('2025-11-29T00:00:00.000Z'),
      },
    ]);
  });

  it('does not flag normal daily candles as suspicious', () => {
    const candles = [
      { timestamp: '2025-12-01T00:00:00.000Z', open: 10, high: 11, low: 9.8, close: 10.7 },
      { timestamp: '2025-12-02T00:00:00.000Z', open: 10.7, high: 11.2, low: 10.3, close: 10.9 },
      { timestamp: '2025-12-03T00:00:00.000Z', open: 10.9, high: 11.4, low: 10.5, close: 11.1 },
      { timestamp: '2025-12-04T00:00:00.000Z', open: 11.1, high: 11.7, low: 10.8, close: 11.4 },
      { timestamp: '2025-12-05T00:00:00.000Z', open: 11.4, high: 11.9, low: 11.1, close: 11.6 },
      { timestamp: '2025-12-06T00:00:00.000Z', open: 11.6, high: 12.1, low: 11.3, close: 11.8 },
    ];

    expect(findSuspiciousDailyRanges(candles)).toEqual([]);
  });
});
