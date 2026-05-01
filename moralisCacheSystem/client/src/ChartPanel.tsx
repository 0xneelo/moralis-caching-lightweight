import { useEffect, useMemo, useRef } from 'react';
import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  type IChartApi,
  type IRange,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { ChartCandle, Timeframe, TimeWindow } from './api';

type ChartPanelProps = {
  candles: ChartCandle[];
  error: string | null;
  timeframe: Timeframe;
  debugColors: boolean;
  visibleRange: TimeWindow;
  visibleRangeRevision: number;
  onVisibleRangeChange: (range: TimeWindow) => void;
};

export function ChartPanel({
  candles,
  error,
  timeframe,
  debugColors,
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
  const candlesRef = useRef(candles);
  const timeframeRef = useRef(timeframe);
  const suppressVisibleRangeEventRef = useRef(false);

  const chartData = useMemo(
    () =>
      candles.map((candle) => ({
        time: candle.time as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        ...getCandleColors(candle, debugColors),
      })),
    [candles, debugColors]
  );

  const volumeData = useMemo(
    () =>
      candles.map((candle) => ({
        time: candle.time as UTCTimestamp,
        value: candle.volume ?? 0,
        color: getVolumeColor(candle, debugColors),
      })),
    [candles, debugColors]
  );

  useEffect(() => {
    onVisibleRangeChangeRef.current = onVisibleRangeChange;
  }, [onVisibleRangeChange]);

  useEffect(() => {
    visibleRangeRef.current = visibleRange;
  }, [visibleRange]);

  useEffect(() => {
    candlesRef.current = candles;
  }, [candles]);

  useEffect(() => {
    timeframeRef.current = timeframe;
  }, [timeframe]);

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

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      base: 0,
    });

    volumeSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.78,
        bottom: 0,
      },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    const handleVisibleRangeChange = (range: IRange<number> | null) => {
      if (!range || suppressVisibleRangeEventRef.current) {
        return;
      }

      const inferredRange = inferVisibleTimeRangeFromLogicalRange({
        logicalRange: range,
        candles: candlesRef.current,
        timeframe: timeframeRef.current,
      });

      if (inferredRange) {
        onVisibleRangeChangeRef.current(inferredRange);
      }
    };

    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRangeChange);

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleRangeChange);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    suppressVisibleRangeEventRef.current = true;
    candleSeriesRef.current?.applyOptions({
      priceFormat: getPriceFormat(candles),
    });
    candleSeriesRef.current?.setData(chartData);
    volumeSeriesRef.current?.setData(volumeData);

    if (chartData.length > 0) {
      candleSeriesRef.current?.priceScale().setAutoScale(true);
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
      from: Math.floor(range.from.getTime() / 1000) as UTCTimestamp,
      to: Math.floor(range.to.getTime() / 1000) as UTCTimestamp,
    });
    window.setTimeout(() => {
      suppressVisibleRangeEventRef.current = false;
    }, 500);
  }, [chartData.length, visibleRangeRevision]);

  return (
    <div className="chart-shell">
      <div ref={containerRef} className="chart-canvas" />
      {error ? (
        <div className="chart-empty chart-error">
          <span>Chart request failed</span>
          <small>{error}</small>
        </div>
      ) : candles.length === 0 ? (
        <div className="chart-empty">
          <span>No candles loaded yet</span>
          <small>Start the backend or choose a shorter range.</small>
        </div>
      ) : null}
    </div>
  );
}

function inferVisibleTimeRangeFromLogicalRange(params: {
  logicalRange: IRange<number>;
  candles: ChartCandle[];
  timeframe: Timeframe;
}): TimeWindow | null {
  const firstCandle = params.candles[0];

  if (!firstCandle) {
    return null;
  }

  const stepMs = timeframeToSeconds(params.timeframe) * 1000;
  const firstTimeMs = firstCandle.time * 1000;
  const from = new Date(firstTimeMs + Math.floor(params.logicalRange.from) * stepMs);
  const to = new Date(firstTimeMs + Math.ceil(params.logicalRange.to + 1) * stepMs);

  if (to <= from) {
    return null;
  }

  return { from, to };
}

function timeframeToSeconds(timeframe: Timeframe) {
  switch (timeframe) {
    case '1min':
      return 60;
    case '5min':
      return 5 * 60;
    case '10min':
      return 10 * 60;
    case '30min':
      return 30 * 60;
    case '1h':
      return 60 * 60;
    case '4h':
      return 4 * 60 * 60;
    case '6h':
      return 6 * 60 * 60;
    case '12h':
      return 12 * 60 * 60;
    case '1d':
      return 24 * 60 * 60;
    case '1w':
      return 7 * 24 * 60 * 60;
    case '1M':
      return 30 * 24 * 60 * 60;
  }
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
