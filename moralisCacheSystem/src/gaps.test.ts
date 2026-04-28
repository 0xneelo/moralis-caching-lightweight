import { describe, expect, it } from 'vitest';
import { findMissingRanges } from './gaps.js';

describe('findMissingRanges', () => {
  it('finds missing candle ranges', () => {
    const gaps = findMissingRanges({
      timeframe: '1min',
      from: new Date('2026-04-28T00:00:00.000Z'),
      to: new Date('2026-04-28T00:05:00.000Z'),
      candles: [
        { timestamp: new Date('2026-04-28T00:00:00.000Z') },
        { timestamp: new Date('2026-04-28T00:01:00.000Z') },
        { timestamp: new Date('2026-04-28T00:04:00.000Z') },
      ],
    });

    expect(gaps).toEqual([
      {
        from: new Date('2026-04-28T00:02:00.000Z'),
        to: new Date('2026-04-28T00:04:00.000Z'),
      },
    ]);
  });
});
