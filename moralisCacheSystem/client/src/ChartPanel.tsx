import { useEffect, useMemo, useRef } from 'react';
import {
  CandlestickSeries,
  HistogramSeries,
  PriceScaleMode,
  createChart,
  type IChartApi,
  type IRange,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
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
  /** Effective series resolution (must match candle bucket size for correct x-axis). */
  effectiveTimeframe: Timeframe;
  visibleRange: TimeWindow;
  visibleRangeRevision: number;
  onVisibleRangeChange: (range: TimeWindow) => void;
};

export function ChartPanel({
  candles,
  error,
  loading,
  emptyTitle,
  emptySubtitle,
  historyWarmup,
  historyProgressPct,
  debugColors,
  effectiveTimeframe,
  visibleRange,
  visibleRangeRevision,
  onVisibleRangeChange,
}: ChartPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const onVisibleRangeChangeRef = useRef(onVisibleRangeChange);
  const visibleRangeRef = useRef(visibleRange);
  const suppressVisibleRangeEventRef = useRef(false);

  const chartData = useMemo(
    () =>
      candles
        .filter((candle) => candle.source !== 'filled')
        .map((candle) => {
          const normalized = normalizeOhlc(candle);
          const time = candleSecondsToChartTime(normalized.time, effectiveTimeframe);

          return {
            time,
            open: normalized.open,
            high: normalized.high,
            low: normalized.low,
            close: normalized.close,
            ...getCandleColors(normalized, debugColors),
          };
        }),
    [candles, debugColors, effectiveTimeframe]
  );

  const volumeData = useMemo(
    () =>
      candles
        .filter((candle) => candle.source !== 'filled')
        .map((candle) => ({
          time: candleSecondsToChartTime(candle.time, effectiveTimeframe),
          value: candle.volume ?? 0,
          color: getVolumeColor(candle, debugColors),
        })),
    [candles, debugColors, effectiveTimeframe]
  );

  useEffect(() => {
    onVisibleRangeChangeRef.current = onVisibleRangeChange;
  }, [onVisibleRangeChange]);

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

    chart.timeScale().subscribeVisibleTimeRangeChange(handleVisibleRangeChange);

    return () => {
      chart.timeScale().unsubscribeVisibleTimeRangeChange(handleVisibleRangeChange);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, [effectiveTimeframe]);

  useEffect(() => {
    suppressVisibleRangeEventRef.current = true;
    candleSeriesRef.current?.applyOptions({
      priceFormat: getPriceFormat(candles),
    });
    candleSeriesRef.current?.setData(chartData);
    volumeSeriesRef.current?.setData(volumeData);

    if (chartData.length > 0) {
      candleSeriesRef.current?.priceScale().setAutoScale(true);
      candleSeriesRef.current?.priceScale().applyOptions({
        mode: computePriceScaleMode(chartData),
        // No bottom padding — avoids sub-$1 charts painting ticks below zero.
        scaleMargins: { top: 0.12, bottom: 0 },
      });
    }

    window.setTimeout(() => {
      suppressVisibleRangeEventRef.current = false;
    }, 500);
  }, [candles, chartData, volumeData]);

  useEffect(() => {
    if (chartData.length === 0) {
      return;
    }

    suppressVisibleRangeEventRef.current = true;
    const range = visibleRangeRef.current;
    chartRef.current?.timeScale().setVisibleRange({
      from: windowDateToChartTime(range.from, effectiveTimeframe),
      to: windowDateToChartTime(range.to, effectiveTimeframe),
    });
    window.setTimeout(() => {
      suppressVisibleRangeEventRef.current = false;
    }, 500);
  }, [chartData.length, visibleRangeRevision, effectiveTimeframe]);

  return (
    <div className="chart-shell">
      <div ref={containerRef} className="chart-canvas" />
      {historyWarmup ? (
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

function getCandleColors(candle: ChartCandle, debugColors: boolean) {
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

  const color = bullish ? '#46b297' : '#dc5b7f';
  return {
    color,
    wickColor: color,
  };
}

function normalizeOhlc(candle: ChartCandle): ChartCandle {
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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getVolumeColor(candle: ChartCandle, debugColors: boolean) {
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

