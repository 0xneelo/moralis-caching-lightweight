import { describe, expect, it } from 'vitest';
import { alignToCandleStart, estimateCandleCount } from './timeframes.js';

describe('timeframes', () => {
  it('estimates candle counts', () => {
    const from = new Date('2026-04-28T00:00:00.000Z');
    const to = new Date('2026-04-28T01:00:00.000Z');

    expect(estimateCandleCount(from, to, '1min')).toBe(60);
    expect(estimateCandleCount(from, to, '5min')).toBe(12);
  });

  it('aligns dates to candle starts', () => {
    const date = new Date('2026-04-28T01:02:34.000Z');

    expect(alignToCandleStart(date, '1min').toISOString()).toBe('2026-04-28T01:02:00.000Z');
    expect(alignToCandleStart(date, '5min').toISOString()).toBe('2026-04-28T01:00:00.000Z');
  });
});
