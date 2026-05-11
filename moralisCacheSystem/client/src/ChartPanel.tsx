import { useEffect, useMemo, useRef } from 'react';
import {
  CandlestickSeries,
  type CandlestickData,
  HistogramSeries,
  type HistogramData,
  PriceScaleMode,
  createChart,
  type IChartApi,
  type IRange,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
  type WhitespaceData,
} from 'lightweight-charts';
import type { ChartCandle, TimeWindow, Timeframe } from './api';

type ChartPanelProps = {
  candles: ChartCandle[];
  error: string | null;
  loading: boolean;
  emptyTitle?: string | undefined;
  emptySubtitle?: string | undefined;
  historyWarmup: boolean;
  historyProgressPct: number | null;
  debugColors: boolean;
  showFilledCandles: boolean;
  dexscreenerMode: boolean;
  scrollModeEnabled: boolean;
  syntheticMode: boolean;
  /** Effective series resolution (must match candle bucket size for correct x-axis). */
  effectiveTimeframe: Timeframe;
  visibleRange: TimeWindow;
  visibleCandleCount: number;
  visibleRangeRevision: number;
  onVisibleRangeChange: (range: TimeWindow) => void;
  onVisibleLogicalRangeChange: (range: VisibleLogicalRange) => void;
};

type VisibleLogicalRange = {
  from: number;
  to: number;
  totalBars: number;
  firstTime: number | null;
  lastTime: number | null;
};

type RenderCandle = Omit<ChartCandle, 'source'> & {
  source?: ChartCandle['source'] | 'synthetic';
};

const DEXSCREENER_FLAT_RANGE_PCT = 0.0005;
const DEXSCREENER_FLAT_BODY_PCT = 0.00025;

export function ChartPanel({
  candles,
  error,
  loading,
  emptyTitle,
  emptySubtitle,
  historyWarmup,
  historyProgressPct,
  debugColors,
  showFilledCandles,
  dexscreenerMode,
  scrollModeEnabled,
  syntheticMode,
  effectiveTimeframe,
  visibleRange,
  visibleCandleCount,
  visibleRangeRevision,
  onVisibleRangeChange,
  onVisibleLogicalRangeChange,
}: ChartPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const onVisibleRangeChangeRef = useRef(onVisibleRangeChange);
  const onVisibleLogicalRangeChangeRef = useRef(onVisibleLogicalRangeChange);
  const timeScaleCandlesRef = useRef<RenderCandle[]>([]);
  const visibleRangeRef = useRef(visibleRange);
  const suppressVisibleRangeEventRef = useRef(false);
  const lastAppliedVisibleRangeRevisionRef = useRef<number | null>(null);
  const lastAppliedTimeframeRef = useRef<Timeframe | null>(null);
  const lastAppliedDexscreenerModeRef = useRef<boolean | null>(null);
  const lastAppliedVisibleCandleCountRef = useRef<number | null>(null);
  const timeScaleCandles = useMemo(() => {
    const byChartTime = new Map<string, RenderCandle>();

    for (const candle of candles) {
      if ((dexscreenerMode || syntheticMode) && candle.source === 'filled') {
        continue;
      }

      const chartTime = candleSecondsToChartTime(candle.time, effectiveTimeframe);
      const chartTimeKey = getChartTimeKey(chartTime);
      const existing = byChartTime.get(chartTimeKey);
      if (existing && existing.source !== 'filled' && candle.source === 'filled') {
        continue;
      }

      byChartTime.set(chartTimeKey, candle);
    }

    let sortedCandles = [...byChartTime.values()].sort((left, right) => left.time - right.time);

    if (dexscreenerMode) {
      sortedCandles = mergeDexscreenerFlatRuns(sortedCandles);
    }

    return syntheticMode ? insertSyntheticGapCandles(sortedCandles) : sortedCandles;
  }, [candles, dexscreenerMode, effectiveTimeframe, syntheticMode]);

  const chartData = useMemo<Array<CandlestickData<Time> | WhitespaceData<Time>>>(
    () =>
      timeScaleCandles.map((candle) => {
        const time = candleSecondsToChartTime(candle.time, effectiveTimeframe);

        if (!showFilledCandles && candle.source === 'filled') {
          return { time };
        }

        const normalized = normalizeOhlc(candle);

        return {
          time,
          open: normalized.open,
          high: normalized.high,
          low: normalized.low,
          close: normalized.close,
          ...getCandleColors(normalized, debugColors),
        };
      }),
    [timeScaleCandles, debugColors, effectiveTimeframe, showFilledCandles]
  );

  const volumeData = useMemo<Array<HistogramData<Time> | WhitespaceData<Time>>>(
    () =>
      timeScaleCandles.map((candle) => {
        const time = candleSecondsToChartTime(candle.time, effectiveTimeframe);

        if (!showFilledCandles && candle.source === 'filled') {
          return { time };
        }

        return {
          time,
          value: candle.volume ?? 0,
          color: getVolumeColor(candle, debugColors),
        };
      }),
    [timeScaleCandles, debugColors, effectiveTimeframe, showFilledCandles]
  );

  const visibleOhlcData = useMemo(() => chartData.filter(isCandlestickData), [chartData]);

  useEffect(() => {
    onVisibleRangeChangeRef.current = onVisibleRangeChange;
  }, [onVisibleRangeChange]);

  useEffect(() => {
    onVisibleLogicalRangeChangeRef.current = onVisibleLogicalRangeChange;
  }, [onVisibleLogicalRangeChange]);

  useEffect(() => {
    timeScaleCandlesRef.current = timeScaleCandles;
  }, [timeScaleCandles]);

  useEffect(() => {
    visibleRangeRef.current = visibleRange;
  }, [visibleRange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: '#aab0c7',
        fontFamily: '"Azeret Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      grid: {
        vertLines: { color: 'rgba(128, 137, 177, 0.08)' },
        horzLines: { color: 'rgba(128, 137, 177, 0.08)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(128, 137, 177, 0.14)',
      },
      timeScale: {
        borderColor: 'rgba(128, 137, 177, 0.14)',
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: getChartScrollOptions(scrollModeEnabled),
      handleScale: getChartScaleOptions(scrollModeEnabled),
      crosshair: {
        vertLine: { color: 'rgba(182, 189, 255, 0.36)' },
        horzLine: { color: 'rgba(182, 189, 255, 0.36)' },
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#46b297',
      downColor: '#dc5b7f',
      wickUpColor: '#6ed4bc',
      wickDownColor: '#f0759a',
      borderVisible: false,
      priceFormat: getPriceFormat(candles),
    });

    // Dedicated volume pane (Dexscreener / TV-style). Overlay histogram + shared scaling
    // made volume compete with OHLC on one axis → bogus negatives & crushed candles.
    const mainPane = chart.panes()[0];
    const volumePane = chart.addPane();
    mainPane?.setStretchFactor(5);
    volumePane.setStretchFactor(1);

    const volumeSeries = volumePane.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      base: 0,
    });

    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.06, bottom: 0 },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    const handleVisibleRangeChange = (range: IRange<Time> | null) => {
      if (!range || suppressVisibleRangeEventRef.current) {
        return;
      }

      const inferredRange = inferVisibleTimeRangeFromTimeRange(range);

      if (inferredRange) {
        onVisibleRangeChangeRef.current(inferredRange);
      }
    };

    const handleVisibleLogicalRangeChange = (range: { from: number; to: number } | null) => {
      if (!range || suppressVisibleRangeEventRef.current) {
        return;
      }

      const currentCandles = timeScaleCandlesRef.current;

      onVisibleLogicalRangeChangeRef.current({
        from: range.from,
        to: range.to,
        totalBars: currentCandles.length,
        firstTime: currentCandles[0]?.time ?? null,
        lastTime: currentCandles[currentCandles.length - 1]?.time ?? null,
      });
    };

    chart.timeScale().subscribeVisibleTimeRangeChange(handleVisibleRangeChange);
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleLogicalRangeChange);

    return () => {
      chart.timeScale().unsubscribeVisibleTimeRangeChange(handleVisibleRangeChange);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleLogicalRangeChange);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, [effectiveTimeframe]);

  useEffect(() => {
    chartRef.current?.applyOptions({
      handleScroll: getChartScrollOptions(scrollModeEnabled),
      handleScale: getChartScaleOptions(scrollModeEnabled),
    });
  }, [scrollModeEnabled]);

  useEffect(() => {
    suppressVisibleRangeEventRef.current = true;
    candleSeriesRef.current?.applyOptions({
      priceFormat: getPriceFormat(candles),
    });
    candleSeriesRef.current?.setData(chartData);
    volumeSeriesRef.current?.setData(volumeData);

    if (visibleOhlcData.length > 0) {
      candleSeriesRef.current?.priceScale().setAutoScale(true);
      candleSeriesRef.current?.priceScale().applyOptions({
        mode: computePriceScaleMode(visibleOhlcData),
        // No bottom padding — avoids sub-$1 charts painting ticks below zero.
        scaleMargins: { top: 0.12, bottom: 0 },
      });
    }

    window.setTimeout(() => {
      suppressVisibleRangeEventRef.current = false;
    }, 500);
  }, [candles, chartData, volumeData, visibleOhlcData]);

  useEffect(() => {
    if (chartData.length === 0) {
      return;
    }

    if (
      lastAppliedVisibleRangeRevisionRef.current === visibleRangeRevision &&
      lastAppliedTimeframeRef.current === effectiveTimeframe &&
      lastAppliedDexscreenerModeRef.current === dexscreenerMode &&
      lastAppliedVisibleCandleCountRef.current === visibleCandleCount
    ) {
      return;
    }

    lastAppliedVisibleRangeRevisionRef.current = visibleRangeRevision;
    lastAppliedTimeframeRef.current = effectiveTimeframe;
    lastAppliedDexscreenerModeRef.current = dexscreenerMode;
    lastAppliedVisibleCandleCountRef.current = visibleCandleCount;
    suppressVisibleRangeEventRef.current = true;

    if (dexscreenerMode) {
      const lastIndex = chartData.length - 1;
      const from = Math.max(0, lastIndex - visibleCandleCount + 1);

      try {
        chartRef.current?.timeScale().setVisibleLogicalRange({
          from,
          to: lastIndex,
        });
      } catch {
        chartRef.current?.timeScale().fitContent();
      }

      window.setTimeout(() => {
        suppressVisibleRangeEventRef.current = false;
      }, 500);
      return;
    }

    const range = visibleRangeRef.current;
    const firstDataDate = chartTimeToDate(chartData[0]!.time);
    const lastDataDate = chartTimeToDate(chartData[chartData.length - 1]!.time);

    if (!firstDataDate || !lastDataDate) {
      suppressVisibleRangeEventRef.current = false;
      return;
    }

    const clampedFrom = new Date(Math.max(range.from.getTime(), firstDataDate.getTime()));
    const clampedTo = new Date(Math.min(range.to.getTime(), lastDataDate.getTime()));

    try {
      if (clampedTo <= clampedFrom) {
        chartRef.current?.timeScale().fitContent();
      } else {
        chartRef.current?.timeScale().setVisibleRange({
          from: windowDateToChartTime(clampedFrom, effectiveTimeframe),
          to: windowDateToChartTime(clampedTo, effectiveTimeframe),
        });
      }
    } catch {
      // lightweight-charts can throw when a range maps to null logical indexes.
      // Falling back to fitContent keeps the chart usable instead of crashing.
      chartRef.current?.timeScale().fitContent();
    }
    window.setTimeout(() => {
      suppressVisibleRangeEventRef.current = false;
    }, 500);
  }, [chartData.length, dexscreenerMode, visibleCandleCount, visibleRangeRevision, effectiveTimeframe]);

  return (
    <div className="chart-shell">
      <div ref={containerRef} className="chart-canvas" />
      {historyWarmup && candles.length === 0 ? (
        <div className="chart-empty chart-warmup">
          <div className="chart-warmup-spinner" aria-hidden="true" />
          <span>
            {`Building full market history (${Math.max(0, Math.min(100, historyProgressPct ?? 0))}% complete)`}
          </span>
          <small>Fetching and verifying first-to-latest candles before rendering.</small>
        </div>
      ) : error ? (
        <div className="chart-empty chart-error">
          <span>Chart request failed</span>
          <small>{error}</small>
        </div>
      ) : candles.length === 0 ? (
        <div className="chart-empty">
          <span>{loading ? 'Loading candles...' : (emptyTitle ?? 'No candles returned')}</span>
          <small>
            {loading
              ? 'Checking local cache first, then Moralis only if the cache is missing this window.'
              : (emptySubtitle ?? 'The provider returned no OHLCV candles for this pair and range.')}
          </small>
        </div>
      ) : null}
    </div>
  );
}

/** Daily bars should use {@link BusinessDay} time — matches lightweight-charts expectations. */
function candleSecondsToChartTime(timeSeconds: number, timeframe: Timeframe): Time {
  if (timeframe === '1d') {
    const d = new Date(timeSeconds * 1000);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
    };
  }
  return timeSeconds as UTCTimestamp;
}

function windowDateToChartTime(date: Date, timeframe: Timeframe): Time {
  if (timeframe === '1d') {
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    };
  }
  return Math.floor(date.getTime() / 1000) as UTCTimestamp;
}

function inferVisibleTimeRangeFromTimeRange(range: IRange<Time>): TimeWindow | null {
  const from = chartTimeToDate(range.from);
  const to = chartTimeToDate(range.to);

  if (!from || !to || to <= from) {
    return null;
  }

  return { from, to };
}

function chartTimeToDate(value: Time): Date | null {
  if (typeof value === 'number') {
    return new Date(value * 1000);
  }

  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  if (
    typeof value === 'object' &&
    value !== null &&
    'year' in value &&
    'month' in value &&
    'day' in value
  ) {
    const parsed = new Date(Date.UTC(value.year, value.month - 1, value.day));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

function getChartTimeKey(value: Time) {
  if (typeof value === 'number' || typeof value === 'string') {
    return String(value);
  }

  return `${value.year}-${value.month}-${value.day}`;
}

function getCandleColors(candle: RenderCandle, debugColors: boolean) {
  const bullish = candle.close >= candle.open;

  if (!debugColors) {
    const color = bullish ? '#46b297' : '#dc5b7f';
    return {
      color,
      wickColor: color,
    };
  }

  if (candle.source === 'cache') {
    const color = bullish ? '#3b82f6' : '#f59e0b';
    return {
      color,
      wickColor: color,
    };
  }

  if (candle.source === 'demo') {
    const color = bullish ? '#8b5cf6' : '#f97316';
    return {
      color,
      wickColor: color,
    };
  }

  if (candle.source === 'filled') {
    const color = '#64748b';
    return {
      color,
      wickColor: color,
    };
  }

  if (candle.source === 'synthetic') {
    const color = '#22d3ee';
    return {
      color,
      wickColor: color,
    };
  }

  const color = bullish ? '#46b297' : '#dc5b7f';
  return {
    color,
    wickColor: color,
  };
}

function normalizeOhlc(candle: RenderCandle): RenderCandle {
  const open = Number(candle.open);
  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);

  if (![open, high, low, close].every(Number.isFinite)) {
    return candle;
  }

  const rangeHigh = Math.max(high, low);
  const rangeLow = Math.min(high, low);

  return {
    ...candle,
    open: clamp(open, rangeLow, rangeHigh),
    high: rangeHigh,
    low: rangeLow,
    close: clamp(close, rangeLow, rangeHigh),
  };
}

function mergeDexscreenerFlatRuns(candles: RenderCandle[]) {
  const mergedCandles: RenderCandle[] = [];
  let flatRun: RenderCandle[] = [];

  const flushFlatRun = () => {
    if (flatRun.length === 0) {
      return;
    }

    mergedCandles.push(flatRun.length === 1 ? flatRun[0]! : mergeCandleRun(flatRun));
    flatRun = [];
  };

  for (const candle of candles) {
    if (isDexscreenerFlatCandle(candle)) {
      flatRun.push(candle);
      continue;
    }

    flushFlatRun();
    mergedCandles.push(candle);
  }

  flushFlatRun();

  return mergedCandles;
}

function isDexscreenerFlatCandle(candle: RenderCandle) {
  const normalized = normalizeOhlc(candle);
  const values = [normalized.open, normalized.high, normalized.low, normalized.close];

  if (!values.every(Number.isFinite)) {
    return false;
  }

  const priceBase = Math.max(...values.map((value) => Math.abs(value)), Number.EPSILON);
  const rangePct = Math.abs(normalized.high - normalized.low) / priceBase;
  const bodyPct = Math.abs(normalized.close - normalized.open) / priceBase;

  return rangePct <= DEXSCREENER_FLAT_RANGE_PCT && bodyPct <= DEXSCREENER_FLAT_BODY_PCT;
}

function mergeCandleRun(candles: RenderCandle[]): RenderCandle {
  const normalizedCandles = candles.map(normalizeOhlc);
  const first = normalizedCandles[0]!;
  const last = normalizedCandles[normalizedCandles.length - 1]!;
  const volumes = normalizedCandles
    .map((candle) => candle.volume)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const trades = normalizedCandles
    .map((candle) => candle.trades)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const source = normalizedCandles.find((candle) => candle.source && candle.source !== 'filled')?.source ?? first.source;

  const merged: RenderCandle = {
    ...first,
    open: first.open,
    high: Math.max(...normalizedCandles.map((candle) => candle.high)),
    low: Math.min(...normalizedCandles.map((candle) => candle.low)),
    close: last.close,
    volume: volumes.length > 0 ? volumes.reduce((sum, value) => sum + value, 0) : null,
    trades: trades.length > 0 ? trades.reduce((sum, value) => sum + value, 0) : null,
  };

  if (source) {
    merged.source = source;
  }

  return merged;
}

function insertSyntheticGapCandles(candles: RenderCandle[]) {
  if (candles.length < 2) {
    return candles;
  }

  const nextCandles: RenderCandle[] = [];

  for (let index = 0; index < candles.length; index += 1) {
    const current = candles[index]!;
    const next = candles[index + 1];
    nextCandles.push(current);

    if (!next) {
      continue;
    }

    const synthetic = getSyntheticGapCandle(current, next);
    if (synthetic) {
      nextCandles.push(synthetic);
    }
  }

  return nextCandles;
}

function getSyntheticGapCandle(previousCandle: RenderCandle, nextCandle: RenderCandle): RenderCandle | null {
  const previous = normalizeOhlc(previousCandle);
  const next = normalizeOhlc(nextCandle);
  const gap = next.open - previous.close;

  if (!Number.isFinite(gap) || Math.abs(gap) <= Number.EPSILON) {
    return null;
  }

  const syntheticTime = Math.floor((previous.time + next.time) / 2);

  if (syntheticTime <= previous.time || syntheticTime >= next.time) {
    return null;
  }

  const high = Math.max(previous.close, next.open);
  const low = Math.min(previous.close, next.open);

  return {
    time: syntheticTime,
    timestamp: new Date(syntheticTime * 1000).toISOString(),
    open: previous.close,
    high,
    low,
    close: next.open,
    volume: null,
    trades: null,
    source: 'synthetic',
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getChartScrollOptions(enabled: boolean) {
  return {
    mouseWheel: enabled,
    pressedMouseMove: enabled,
    horzTouchDrag: enabled,
    vertTouchDrag: false,
  };
}

function getChartScaleOptions(enabled: boolean) {
  return {
    axisPressedMouseMove: enabled,
    mouseWheel: enabled,
    pinch: enabled,
  };
}

function getVolumeColor(candle: RenderCandle, debugColors: boolean) {
  const bullish = candle.close >= candle.open;

  if (!debugColors) {
    return bullish ? 'rgba(70, 178, 151, 0.42)' : 'rgba(220, 91, 127, 0.42)';
  }

  if (candle.source === 'cache') {
    return bullish ? 'rgba(59, 130, 246, 0.42)' : 'rgba(245, 158, 11, 0.42)';
  }

  if (candle.source === 'demo') {
    return bullish ? 'rgba(139, 92, 246, 0.42)' : 'rgba(249, 115, 22, 0.42)';
  }

  if (candle.source === 'filled') {
    return 'rgba(100, 116, 139, 0.18)';
  }

  if (candle.source === 'synthetic') {
    return 'rgba(34, 211, 238, 0.18)';
  }

  return bullish ? 'rgba(70, 178, 151, 0.42)' : 'rgba(220, 91, 127, 0.42)';
}

function getPriceFormat(candles: ChartCandle[]) {
  const values = candles.flatMap((candle) => [candle.open, candle.high, candle.low, candle.close]);
  const maxAbs = Math.max(...values.map(Math.abs).filter(Number.isFinite), 0);
  const precision = getPrecisionForPrice(maxAbs);

  return {
    type: 'price' as const,
    precision,
    minMove: 10 ** -precision,
  };
}

function getPrecisionForPrice(price: number) {
  if (price < 0.000000001) return 14;
  if (price < 0.000001) return 12;
  if (price < 0.0001) return 10;
  if (price < 0.01) return 8;
  if (price < 1) return 6;
  if (price < 100) return 4;
  return 2;
}

function isCandlestickData(data: CandlestickData<Time> | WhitespaceData<Time>): data is CandlestickData<Time> {
  return 'open' in data && 'high' in data && 'low' in data && 'close' in data;
}

/** Wide positive-only spans compress spikes like Dexscreener’s default log chart for microcaps. */
function computePriceScaleMode(candles: Array<{ open: number; high: number; low: number; close: number }>) {
  let minPos = Infinity;
  let maxPos = -Infinity;

  for (const candle of candles) {
    for (const value of [candle.open, candle.high, candle.low, candle.close]) {
      if (typeof value === 'number' && value > 0 && Number.isFinite(value)) {
        minPos = Math.min(minPos, value);
        maxPos = Math.max(maxPos, value);
      }
    }
  }

  if (!(minPos > 0 && maxPos > 0 && Number.isFinite(minPos) && Number.isFinite(maxPos))) {
    return PriceScaleMode.Normal;
  }

  return maxPos / minPos >= 6 ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal;
}

