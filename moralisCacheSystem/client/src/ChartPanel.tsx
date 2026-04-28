import { useEffect, useMemo, useRef } from 'react';
import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { ChartCandle } from './api';

type ChartPanelProps = {
  candles: ChartCandle[];
  error: string | null;
};

export function ChartPanel({ candles, error }: ChartPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const priceRangeRef = useRef<{ minValue: number; maxValue: number } | null>(null);

  const chartData = useMemo(
    () =>
      candles.map((candle) => ({
        time: candle.time as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      })),
    [candles]
  );

  const volumeData = useMemo(
    () =>
      candles.map((candle) => ({
        time: candle.time as UTCTimestamp,
        value: candle.volume ?? 0,
        color: candle.close >= candle.open ? 'rgba(70, 178, 151, 0.42)' : 'rgba(220, 91, 127, 0.42)',
      })),
    [candles]
  );

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
      autoscaleInfoProvider: () =>
        priceRangeRef.current
          ? {
              priceRange: priceRangeRef.current,
              margins: {
                above: 28,
                below: 28,
              },
            }
          : null,
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

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const priceRange = getPriceRange(candles);
    priceRangeRef.current = priceRange;

    candleSeriesRef.current?.applyOptions({
      priceFormat: getPriceFormat(candles),
    });
    candleSeriesRef.current?.setData(chartData);
    volumeSeriesRef.current?.setData(volumeData);

    if (chartData.length > 0) {
      candleSeriesRef.current?.priceScale().setAutoScale(true);
      chartRef.current?.timeScale().fitContent();
    }
  }, [candles, chartData, volumeData]);

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

function getPriceRange(candles: ChartCandle[]) {
  const lows = candles.map((candle) => candle.low).filter(Number.isFinite);
  const highs = candles.map((candle) => candle.high).filter(Number.isFinite);

  if (lows.length === 0 || highs.length === 0) {
    return null;
  }

  const low = Math.min(...lows);
  const high = Math.max(...highs);

  if (low === high) {
    const pad = Math.max(Math.abs(low) * 0.02, getMinMoveForPrice(low) * 20);
    return {
      minValue: low - pad,
      maxValue: high + pad,
    };
  }

  const pad = (high - low) * 0.08;

  return {
    minValue: Math.max(0, low - pad),
    maxValue: high + pad,
  };
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

function getMinMoveForPrice(price: number) {
  return 10 ** -getPrecisionForPrice(Math.abs(price));
}
