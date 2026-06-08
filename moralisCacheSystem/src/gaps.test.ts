import { describe, expect, it } from 'vitest';
import { findMissingRanges, prioritizeVisibleRanges } from './gaps.js';

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

  it('prioritizes the newest visible gap for limited live provider fetches', () => {
    const gaps = [
      {
        from: new Date('2026-06-08T05:29:00.000Z'),
        to: new Date('2026-06-08T05:31:00.000Z'),
      },
      {
        from: new Date('2026-06-08T08:52:00.000Z'),
        to: new Date('2026-06-08T08:58:00.000Z'),
      },
      {
        from: new Date('2026-06-08T09:10:00.000Z'),
        to: new Date('2026-06-08T11:30:00.000Z'),
      },
    ];

    expect(
      prioritizeVisibleRanges(gaps, {
        from: new Date('2026-06-08T05:26:00.000Z'),
        to: new Date('2026-06-08T11:30:00.000Z'),
      })
    ).toEqual([
      gaps[2],
      gaps[1],
      gaps[0],
    ]);
  });
});
