import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AdminDashboard } from './AdminDashboard';
import { ChartPanel } from './ChartPanel';
import {
  fetchChartCandles,
  fetchPairMetadata,
  fetchMoralisUsage,
  getEffectiveTimeframeForWindow,
  getMinimumTimeframeForRange,
  getPrefetchWindow,
  getRangeWindow,
  getTimeframeDurationMs,
  type ChartRange,
  type ChartResponse,
  type MoralisUsage,
  type PairMetadata,
  type Timeframe,
} from './api';
import { chainOptions, getChainLabel, getDexscreenerChainSlug } from './chains';
import './styles.css';

const DEFAULT_PAIR = '0x3eB2a8015dE1419a5089dAb37b0056F0fc24f821';
const DEFAULT_CHAIN = 'base';
const DEFAULT_TIMEFRAME: Timeframe = '1h';
const DEFAULT_CHART_RANGE: ChartRange = '30D';

const timeframes: Timeframe[] = ['1min', '5min', '10min', '30min', '1h', '4h', '12h', '1d'];
const chartRanges: ChartRange[] = ['1H', '4H', '8H', '12H', '24H', '48H', '7D', '30D', '2M', '3M', '6M', '1Y', 'ALL'];
const VALID_CHAINS = new Set(chainOptions.map((option) => option.value));
const VALID_TIMEFRAMES = new Set<Timeframe>(timeframes);
const VALID_CHART_RANGES = new Set<ChartRange>(chartRanges);
const MIN_VISIBLE_CANDLE_COUNT = 1;
const MAX_VISIBLE_CANDLE_COUNT = 5_000;
const INITIAL_CHART_ROUTE = getChartRouteFromLocation();
const INITIAL_VISIBLE_RANGE = getRangeWindow(INITIAL_CHART_ROUTE.chartRange);
const INITIAL_VISIBLE_CANDLE_COUNT = getVisibleCandleCountForWindow(
  INITIAL_VISIBLE_RANGE,
  INITIAL_CHART_ROUTE.dexscreenerMode
    ? INITIAL_CHART_ROUTE.timeframe
    : getEffectiveTimeframeForWindow(INITIAL_CHART_ROUTE.timeframe, INITIAL_VISIBLE_RANGE)
);
const CHART_FETCH_DEBOUNCE_MS = 150;
const CHART_ZOOM_DEBOUNCE_MS = 200;
const IGNORE_CHART_RANGE_AFTER_CLICK_MS = 1_500;
const MAX_REFRESH_LOADING_MS = 1_000;
const MIN_ZOOM_OUT_GROWTH_RATIO = 1.03;
const SCROLL_RANGE_DEBOUNCE_MS = 120;
const SCROLL_PREFETCH_EDGE_BARS = 12;
const SCROLL_PREFETCH_GROWTH_RATIO = 1.6;
const MIN_SCROLL_HISTORY_FROM = new Date('2024-01-01T00:00:00.000Z');

type Side = 'buy' | 'sell';

export function App() {
  if (window.location.pathname.startsWith('/admin')) {
    return <AdminDashboard />;
  }

  const [pairAddress, setPairAddress] = useState(INITIAL_CHART_ROUTE.pairAddress);
  const [chain, setChain] = useState(INITIAL_CHART_ROUTE.chain);
  const [timeframe, setTimeframe] = useState<Timeframe>(INITIAL_CHART_ROUTE.timeframe);
  const [chartRange, setChartRange] = useState<ChartRange>(INITIAL_CHART_ROUTE.chartRange);
  const [side, setSide] = useState<Side>('buy');
  const [amount, setAmount] = useState('1000');
  const [slippage, setSlippage] = useState(10);
  const [response, setResponse] = useState<ChartResponse | null>(null);
  const [usage, setUsage] = useState<MoralisUsage | null>(null);
  const [pairMetadata, setPairMetadata] = useState<PairMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshingFromMoralis, setRefreshingFromMoralis] = useState(false);
  const [debugColors, setDebugColors] = useState(true);
  const [showEveryCandle, setShowEveryCandle] = useState(INITIAL_CHART_ROUTE.showEveryCandle);
  const [adaptiveZoomEnabled, setAdaptiveZoomEnabled] = useState(INITIAL_CHART_ROUTE.adaptiveZoomEnabled);
  const [dexscreenerMode, setDexscreenerMode] = useState(INITIAL_CHART_ROUTE.dexscreenerMode);
  const [scrollModeEnabled, setScrollModeEnabled] = useState(INITIAL_CHART_ROUTE.scrollModeEnabled);
  const [syntheticMode, setSyntheticMode] = useState(INITIAL_CHART_ROUTE.syntheticMode);
  const [visibleRange, setVisibleRange] = useState(() => INITIAL_VISIBLE_RANGE);
  const [visibleRangeRevision, setVisibleRangeRevision] = useState(0);
  const [visibleCandleCountInput, setVisibleCandleCountInput] = useState(
    String(INITIAL_CHART_ROUTE.visibleCandleCount ?? INITIAL_VISIBLE_CANDLE_COUNT)
  );
  const [customVisibleCandleCount, setCustomVisibleCandleCount] = useState(
    INITIAL_CHART_ROUTE.visibleCandleCount !== null
  );
  const [activeInteractionId, setActiveInteractionId] = useState<string | undefined>();
  const zoomDebounceRef = useRef<number | null>(null);
  const logicalRangeDebounceRef = useRef<number | null>(null);
  const ignoreChartRangeUntilRef = useRef(0);
  const visibleCandleCountDirtyRef = useRef(false);
  const effectiveTimeframe = useMemo(
    () => (dexscreenerMode ? timeframe : getEffectiveTimeframeForWindow(timeframe, visibleRange)),
    [dexscreenerMode, timeframe, visibleRange]
  );
  const loadRange = useMemo(
    () => (dexscreenerMode ? visibleRange : getPrefetchWindow(visibleRange, effectiveTimeframe)),
    [dexscreenerMode, effectiveTimeframe, visibleRange]
  );
  const maxVisibleCandleCount = useMemo(
    () => (dexscreenerMode ? MAX_VISIBLE_CANDLE_COUNT : getMaxVisibleCandleCountWithoutTimeframeChange(timeframe)),
    [dexscreenerMode, timeframe]
  );
  const visibleCandleCount = useMemo(
    () =>
      clampNumber(
        parseVisibleCandleCount(visibleCandleCountInput) ??
          getVisibleCandleCountForWindow(visibleRange, effectiveTimeframe),
        MIN_VISIBLE_CANDLE_COUNT,
        maxVisibleCandleCount
      ),
    [effectiveTimeframe, maxVisibleCandleCount, visibleCandleCountInput, visibleRange]
  );

  const lastCandle = response?.candles.at(-1);
  const previousCandle = response?.candles.at(-2);
  const showHistoryWarmup = Boolean(response?.historyWarming && !response?.historyComplete);
  const realCandleCount = response?.candles.filter((candle) => candle.source !== 'filled').length ?? 0;
  const filledCandleCount = response?.candles.filter((candle) => candle.source === 'filled').length ?? 0;
  const chainSlug = getDexscreenerChainSlug(chain);
  const dexscreenerUrl = `https://dexscreener.com/${chainSlug}/${pairAddress}`;
  const pairLabel = pairMetadata?.label ?? `${shortenAddress(pairAddress)} / ${getChainLabel(chain)}`;
  const priceChange = useMemo(() => {
    if (!lastCandle || !previousCandle) {
      return 0;
    }

    return ((lastCandle.close - previousCandle.close) / previousCandle.close) * 100;
  }, [lastCandle, previousCandle]);

  useEffect(() => {
    updateChartRoute({
      chain,
      pairAddress,
      timeframe,
      chartRange,
      dexscreenerMode,
      scrollModeEnabled,
      syntheticMode,
      showEveryCandle,
      adaptiveZoomEnabled,
      visibleCandleCount: customVisibleCandleCount ? visibleCandleCount : null,
    });
  }, [
    adaptiveZoomEnabled,
    chain,
    chartRange,
    customVisibleCandleCount,
    dexscreenerMode,
    pairAddress,
    scrollModeEnabled,
    showEveryCandle,
    syntheticMode,
    timeframe,
    visibleCandleCount,
  ]);

  useEffect(() => {
    function handlePopState() {
      const route = getChartRouteFromLocation();
      setChain(route.chain);
      setPairAddress(route.pairAddress);
      setTimeframe(route.timeframe);
      setChartRange(route.chartRange);
      const nextVisibleRange = getRangeWindow(route.chartRange);
      const nextEffectiveTimeframe = route.dexscreenerMode
        ? route.timeframe
        : getEffectiveTimeframeForWindow(route.timeframe, nextVisibleRange);
      setVisibleRange(nextVisibleRange);
      setVisibleCandleCountInput(
        String(route.visibleCandleCount ?? getVisibleCandleCountForWindow(nextVisibleRange, nextEffectiveTimeframe))
      );
      setShowEveryCandle(route.showEveryCandle);
      setAdaptiveZoomEnabled(route.adaptiveZoomEnabled);
      setDexscreenerMode(route.dexscreenerMode);
      setScrollModeEnabled(route.scrollModeEnabled);
      setSyntheticMode(route.syntheticMode);
      visibleCandleCountDirtyRef.current = false;
      setCustomVisibleCandleCount(route.visibleCandleCount !== null);
      setVisibleRangeRevision((current) => current + 1);
    }

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void load();
    }, CHART_FETCH_DEBOUNCE_MS);

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const chartResponse = await fetchChartCandles({
          chain,
          pairAddress,
          timeframe,
          effectiveTimeframe,
          ...loadRange,
          visibleFrom: visibleRange.from,
          visibleTo: visibleRange.to,
          signal: controller.signal,
          interactionId: activeInteractionId,
        });

        if (!controller.signal.aborted) {
          setResponse(chartResponse);
        }
      } catch (loadError) {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load chart');
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [activeInteractionId, chain, effectiveTimeframe, loadRange, pairAddress, timeframe, visibleRange]);

  useEffect(() => {
    let cancelled = false;

    async function loadPairMetadata() {
      setPairMetadata(null);

      try {
        const metadata = await fetchPairMetadata({
          chainSlug,
          pairAddress,
        });

        if (!cancelled) {
          setPairMetadata(metadata);
        }
      } catch {
        if (!cancelled) {
          setPairMetadata(null);
        }
      }
    }

    if (pairAddress.trim()) {
      void loadPairMetadata();
    }

    return () => {
      cancelled = true;
    };
  }, [chainSlug, pairAddress]);

  useEffect(() => {
    let cancelled = false;

    async function loadUsage() {
      try {
        const nextUsage = await fetchMoralisUsage();
        if (!cancelled) {
          setUsage(nextUsage);
        }
      } catch {
        if (!cancelled) {
          setUsage(null);
        }
      }
    }

    void loadUsage();
    const interval = window.setInterval(loadUsage, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [response]);

  function clearPendingZoomUpdate() {
    if (zoomDebounceRef.current !== null) {
      window.clearTimeout(zoomDebounceRef.current);
      zoomDebounceRef.current = null;
    }

    if (logicalRangeDebounceRef.current !== null) {
      window.clearTimeout(logicalRangeDebounceRef.current);
      logicalRangeDebounceRef.current = null;
    }
  }

  function selectChartRange(nextRange: ChartRange) {
    clearPendingZoomUpdate();
    ignoreChartRangeUntilRef.current = Date.now() + IGNORE_CHART_RANGE_AFTER_CLICK_MS;
    const interactionId = createInteractionId();
    setActiveInteractionId(interactionId);
    logInteraction({
      interactionId,
      event: 'chart_range_click',
      selectedValue: nextRange,
      previousValue: chartRange,
      chain,
      pairAddress,
      requestedTimeframe: timeframe,
      effectiveTimeframe,
      chartRange,
      visibleFrom: visibleRange.from.toISOString(),
      visibleTo: visibleRange.to.toISOString(),
      loadedCandles: response?.candles.length,
      source: response?.source,
    });

    const nextVisibleRange = getRangeWindow(nextRange);
    const nextEffectiveTimeframe = dexscreenerMode ? timeframe : getEffectiveTimeframeForWindow(timeframe, nextVisibleRange);
    setChartRange(nextRange);
    setVisibleRange(nextVisibleRange);
    setVisibleCandleCountInput(String(getVisibleCandleCountForWindow(nextVisibleRange, nextEffectiveTimeframe)));
    visibleCandleCountDirtyRef.current = false;
    setCustomVisibleCandleCount(false);
    setVisibleRangeRevision((current) => current + 1);
  }

  function toggleDexscreenerMode() {
    clearPendingZoomUpdate();
    ignoreChartRangeUntilRef.current = Date.now() + IGNORE_CHART_RANGE_AFTER_CLICK_MS;
    setDexscreenerMode((current) => !current);
    setVisibleRangeRevision((current) => current + 1);
  }

  function toggleScrollMode() {
    clearPendingZoomUpdate();
    ignoreChartRangeUntilRef.current = Date.now() + IGNORE_CHART_RANGE_AFTER_CLICK_MS;
    setScrollModeEnabled((current) => !current);
  }

  function toggleSyntheticMode() {
    clearPendingZoomUpdate();
    ignoreChartRangeUntilRef.current = Date.now() + IGNORE_CHART_RANGE_AFTER_CLICK_MS;
    setSyntheticMode((current) => !current);
    setVisibleRangeRevision((current) => current + 1);
  }

  function selectTimeframe(nextTimeframe: Timeframe) {
    clearPendingZoomUpdate();
    ignoreChartRangeUntilRef.current = Date.now() + IGNORE_CHART_RANGE_AFTER_CLICK_MS;
    const interactionId = createInteractionId();
    const nextChartRange = dexscreenerMode ? chartRange : getPreferredRangeForTimeframe(nextTimeframe, chartRange);
    const nextVisibleRange = getRangeWindow(nextChartRange);
    const nextEffectiveTimeframe = dexscreenerMode
      ? nextTimeframe
      : getEffectiveTimeframeForWindow(nextTimeframe, nextVisibleRange);
    setActiveInteractionId(interactionId);
    logInteraction({
      interactionId,
      event: 'candle_resolution_click',
      selectedValue: nextTimeframe,
      previousValue: timeframe,
      chain,
      pairAddress,
      requestedTimeframe: timeframe,
      effectiveTimeframe,
      chartRange,
      visibleFrom: visibleRange.from.toISOString(),
      visibleTo: visibleRange.to.toISOString(),
      loadedCandles: response?.candles.length,
      source: response?.source,
      nextChartRange,
      nextVisibleFrom: nextVisibleRange.from.toISOString(),
      nextVisibleTo: nextVisibleRange.to.toISOString(),
    });

    setChartRange(nextChartRange);
    setVisibleRange(nextVisibleRange);
    setVisibleCandleCountInput(String(getVisibleCandleCountForWindow(nextVisibleRange, nextEffectiveTimeframe)));
    visibleCandleCountDirtyRef.current = false;
    setCustomVisibleCandleCount(false);
    setVisibleRangeRevision((current) => current + 1);
    setTimeframe(nextTimeframe);
  }

  function changeVisibleCandleCount(nextValue: string) {
    visibleCandleCountDirtyRef.current = true;
    setVisibleCandleCountInput(nextValue);

    const parsedCount = parseVisibleCandleCount(nextValue);
    if (parsedCount === null) {
      return;
    }

    const nextCount = clampNumber(parsedCount, MIN_VISIBLE_CANDLE_COUNT, maxVisibleCandleCount);
    if (nextCount !== parsedCount) {
      setVisibleCandleCountInput(String(nextCount));
    }

    applyVisibleCandleCount(nextCount);
  }

  function commitVisibleCandleCount() {
    if (!visibleCandleCountDirtyRef.current) {
      return;
    }

    const parsedCount = parseVisibleCandleCount(visibleCandleCountInput);
    visibleCandleCountDirtyRef.current = false;

    if (parsedCount === null) {
      setVisibleCandleCountInput(String(getVisibleCandleCountForWindow(visibleRange, effectiveTimeframe)));
      return;
    }

    const nextCount = clampNumber(parsedCount, MIN_VISIBLE_CANDLE_COUNT, maxVisibleCandleCount);
    setVisibleCandleCountInput(String(nextCount));
    applyVisibleCandleCount(nextCount);
  }

  function applyVisibleCandleCount(nextCount: number) {
    clearPendingZoomUpdate();
    ignoreChartRangeUntilRef.current = Date.now() + IGNORE_CHART_RANGE_AFTER_CLICK_MS;
    setVisibleRange(getVisibleWindowForCandleCount(nextCount, timeframe, visibleRange.to));
    setCustomVisibleCandleCount(true);
    setVisibleRangeRevision((current) => current + 1);
  }

  const refreshFromMoralis = useCallback(async () => {
    const interactionId = createInteractionId();
    let loadingReleased = false;
    const releaseLoadingState = () => {
      if (loadingReleased) {
        return;
      }
      loadingReleased = true;
      setRefreshingFromMoralis(false);
      setLoading(false);
    };
    const loadingTimeout = window.setTimeout(releaseLoadingState, MAX_REFRESH_LOADING_MS);
    setRefreshingFromMoralis(true);
    setLoading(true);
    setError(null);

    logInteraction({
      interactionId,
      event: 'refresh_from_moralis_click',
      selectedValue: timeframe,
      chain,
      pairAddress,
      requestedTimeframe: timeframe,
      effectiveTimeframe,
      chartRange,
      visibleFrom: visibleRange.from.toISOString(),
      visibleTo: visibleRange.to.toISOString(),
      loadedCandles: response?.candles.length,
      source: response?.source,
    });

    try {
      const chartResponse = await fetchChartCandles({
        chain,
        pairAddress,
        timeframe,
        effectiveTimeframe,
        from: visibleRange.from,
        to: visibleRange.to,
        visibleFrom: visibleRange.from,
        visibleTo: visibleRange.to,
        interactionId,
        refreshFromMoralis: true,
      });
      setResponse(chartResponse);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to refresh from Moralis');
    } finally {
      window.clearTimeout(loadingTimeout);
      releaseLoadingState();
    }
  }, [chain, chartRange, effectiveTimeframe, pairAddress, response, timeframe, visibleRange]);

  const handleVisibleRangeChange = useCallback((nextRange: { from: Date; to: Date }) => {
    if (dexscreenerMode) {
      return;
    }

    if (!adaptiveZoomEnabled) {
      return;
    }

    const clampedRange = clampRangeToNow(nextRange);

    if (Date.now() < ignoreChartRangeUntilRef.current) {
      return;
    }

    if (zoomDebounceRef.current !== null) {
      window.clearTimeout(zoomDebounceRef.current);
    }

    zoomDebounceRef.current = window.setTimeout(() => {
      setVisibleRange((current) => {
        if (areTimeWindowsClose(current, clampedRange)) {
          return current;
        }

        const currentSpanMs = getTimeWindowSpanMs(current);
        const nextSpanMs = getTimeWindowSpanMs(clampedRange);

        if (scrollModeEnabled) {
          const count = getVisibleCandleCountForWindow(clampedRange, effectiveTimeframe);
          setVisibleCandleCountInput(String(clampNumber(count, MIN_VISIBLE_CANDLE_COUNT, maxVisibleCandleCount)));
          setCustomVisibleCandleCount(true);
          return clampedRange;
        }

        // Ignore redraw jitter / auto-pan drift from series updates. Only promote
        // meaningful user zoom-out events that expand the window by at least 3%.
        if (nextSpanMs <= currentSpanMs * MIN_ZOOM_OUT_GROWTH_RATIO) {
          return current;
        }

        return clampedRange;
      });
      zoomDebounceRef.current = null;
    }, scrollModeEnabled ? SCROLL_RANGE_DEBOUNCE_MS : CHART_ZOOM_DEBOUNCE_MS);
  }, [adaptiveZoomEnabled, dexscreenerMode, effectiveTimeframe, maxVisibleCandleCount, scrollModeEnabled]);

  const handleVisibleLogicalRangeChange = useCallback((range: {
    from: number;
    to: number;
    totalBars: number;
    firstTime: number | null;
    lastTime: number | null;
  }) => {
    if (!scrollModeEnabled || !dexscreenerMode || range.totalBars === 0) {
      return;
    }

    if (Date.now() < ignoreChartRangeUntilRef.current) {
      return;
    }

    const visibleBars = Math.max(1, Math.ceil(range.to - range.from));
    const needsEarlierCandles =
      range.from <= SCROLL_PREFETCH_EDGE_BARS ||
      visibleBars >= range.totalBars - SCROLL_PREFETCH_EDGE_BARS;

    if (!needsEarlierCandles) {
      return;
    }

    if (logicalRangeDebounceRef.current !== null) {
      window.clearTimeout(logicalRangeDebounceRef.current);
    }

    logicalRangeDebounceRef.current = window.setTimeout(() => {
      setVisibleRange((current) => {
        if (current.from <= MIN_SCROLL_HISTORY_FROM) {
          return current;
        }

        const currentSpanMs = Math.max(getTimeWindowSpanMs(current), getTimeframeDurationMs(timeframe) * visibleBars);
        const nextFrom = new Date(
          Math.max(
            MIN_SCROLL_HISTORY_FROM.getTime(),
            current.from.getTime() - Math.ceil(currentSpanMs * SCROLL_PREFETCH_GROWTH_RATIO)
          )
        );

        if (nextFrom >= current.from) {
          return current;
        }

        return {
          from: nextFrom,
          to: current.to,
        };
      });
      setCustomVisibleCandleCount(true);
      logicalRangeDebounceRef.current = null;
    }, SCROLL_RANGE_DEBOUNCE_MS);
  }, [dexscreenerMode, scrollModeEnabled, timeframe]);

  useEffect(
    () => () => {
      if (zoomDebounceRef.current !== null) {
        window.clearTimeout(zoomDebounceRef.current);
      }

      if (logicalRangeDebounceRef.current !== null) {
        window.clearTimeout(logicalRangeDebounceRef.current);
      }
    },
    []
  );

  return (
    <main className="terminal">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark">V</div>
          <div>
            <strong>Vibe Cache Terminal</strong>
            <span>Moralis-backed OHLC test rig</span>
          </div>
        </div>

        <div className="topbar-actions">
          <a href={dexscreenerUrl} target="_blank" rel="noreferrer" className="ghost-link">
            Dexscreener
          </a>
          <button
            className={debugColors ? 'mode-toggle active has-tooltip' : 'mode-toggle has-tooltip'}
            onClick={() => setDebugColors((current) => !current)}
            data-tooltip="Dev Colors tints candles by source: cache, Moralis, demo, or filled gaps."
          >
            {debugColors ? 'Dev Colors' : 'Normal Colors'}
          </button>
          <button className="connect-button">Connect Log In</button>
        </div>
      </header>

      <section className="ticker-tape" aria-label="market tape">
        {[
          ['Market', getChainLabel(chain)],
          [pairMetadata?.baseSymbol ?? 'Pair', lastCandle ? `$${lastCandle.close.toFixed(8)}` : 'loading'],
          ['Source', response?.source ?? 'none'],
          ['Candles', timeframe === effectiveTimeframe ? effectiveTimeframe : `${timeframe}->${effectiveTimeframe}`],
          ['Loaded', response ? `${realCandleCount}${filledCandleCount ? ` +${filledCandleCount} gaps` : ''}` : '0'],
          ['Moralis CU', usage ? `${usage.todayCu.toLocaleString()} today` : 'loading'],
          ['Cache', response?.partial ? 'partial' : response ? 'ready' : 'cold'],
          ['Change', `${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)}%`],
        ].map(([label, value]) => (
          <div className="ticker-item" key={label}>
            <span>{label}</span>
            <strong className={label === 'Change' && priceChange < 0 ? 'danger' : ''}>{value}</strong>
          </div>
        ))}
      </section>

      <section className="workspace">
        <aside className="tool-rail" aria-label="chart tools">
          <div className="tool-rail-section">
            <span className="tool-rail-eyebrow">Chart</span>
            <strong>Modes</strong>
          </div>

          <div className={debugColors ? 'dev-color-legend' : 'dev-color-legend muted'} aria-label="dev color legend">
            <div className="tool-rail-section compact">
              <span className="tool-rail-eyebrow">Dev colors</span>
              <strong>{debugColors ? 'Source legend' : 'Disabled'}</strong>
            </div>
            <div className="legend-grid">
              <div className="legend-row">
                <span className="legend-swatch swatch-provider-up" />
                <span className="legend-swatch swatch-provider-down" />
                <span>Provider</span>
              </div>
              <div className="legend-row">
                <span className="legend-swatch swatch-cache-up" />
                <span className="legend-swatch swatch-cache-down" />
                <span>Cache</span>
              </div>
              <div className="legend-row">
                <span className="legend-swatch swatch-demo-up" />
                <span className="legend-swatch swatch-demo-down" />
                <span>Demo</span>
              </div>
              <div className="legend-row">
                <span className="legend-swatch swatch-filled" />
                <span>Filled gap</span>
              </div>
              <div className="legend-row">
                <span className="legend-swatch swatch-synthetic" />
                <span>Synthetic</span>
              </div>
            </div>
          </div>

          <label
            className="visible-candle-field tool-rail-field has-tooltip"
            title={
              dexscreenerMode
                ? `Show up to ${maxVisibleCandleCount.toLocaleString()} real rendered candles in the chart viewport.`
                : `Show this many ${timeframe} candles in the chart viewport. Max ${maxVisibleCandleCount.toLocaleString()} before the app would need a larger timeframe.`
            }
            data-tooltip={
              dexscreenerMode
                ? 'Controls how many real rendered candles fit in the visible chart area.'
                : `Controls the wall-clock viewport size using ${timeframe} candle duration.`
            }
          >
            <span>Visible candles</span>
            <input
              aria-label="visible candle count"
              type="number"
              min={MIN_VISIBLE_CANDLE_COUNT}
              max={maxVisibleCandleCount}
              step="1"
              value={visibleCandleCountInput}
              onChange={(event) => changeVisibleCandleCount(event.target.value)}
              onBlur={commitVisibleCandleCount}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.currentTarget.blur();
                }
              }}
            />
          </label>

          <button
            className={dexscreenerMode ? 'show-empty-toggle active has-tooltip' : 'show-empty-toggle has-tooltip'}
            onClick={toggleDexscreenerMode}
            data-tooltip="When on, missing minutes are compressed away so real candles sit next to each other like Dexscreener."
          >
            {`Dexscreener: ${dexscreenerMode ? 'On' : 'Off'}`}
          </button>
          <button
            className={scrollModeEnabled ? 'show-empty-toggle active has-tooltip' : 'show-empty-toggle has-tooltip'}
            onClick={toggleScrollMode}
            data-tooltip="When on, mouse wheel and drag can pan or zoom the chart, and nearing the left edge requests older candles."
          >
            {`Scroll: ${scrollModeEnabled ? 'On' : 'Off'}`}
          </button>
          <button
            className={syntheticMode ? 'show-empty-toggle active has-tooltip' : 'show-empty-toggle has-tooltip'}
            onClick={toggleSyntheticMode}
            data-tooltip="When on, no-trade filler candles are removed and visual price gaps between traded candles are bridged with synthetic candles."
          >
            {`Synthetic: ${syntheticMode ? 'On' : 'Off'}`}
          </button>
          <button
            className={showEveryCandle ? 'show-empty-toggle active has-tooltip' : 'show-empty-toggle has-tooltip'}
            onClick={() => setShowEveryCandle((current) => !current)}
            title="Toggle filler candles for intervals where the provider returned no OHLCV data"
            data-tooltip="In time-accurate mode, draws synthetic gap candles. Dexscreener mode skips these entirely."
          >
            {`Every candle: ${showEveryCandle ? 'On' : 'Off'}`}
          </button>
          <button
            className={adaptiveZoomEnabled ? 'show-empty-toggle active has-tooltip' : 'show-empty-toggle has-tooltip'}
            onClick={() => setAdaptiveZoomEnabled((current) => !current)}
            title="When enabled, zooming out fetches wider windows and automatically shifts candle size"
            data-tooltip="When on, chart zoom-out expands the loaded date window. Dexscreener mode still keeps the selected candle interval."
          >
            {`Zooming: ${adaptiveZoomEnabled ? 'On' : 'Off'}`}
          </button>
        </aside>

        <section className="chart-zone">
          <div className="pair-strip">
            <div className="pair-title">
              <span className="token-dot" />
              <div>
                <strong>{pairLabel}</strong>
                <small>{pairAddress.slice(0, 6)}...{pairAddress.slice(-4)}</small>
              </div>
            </div>

            <div className="chart-controls">
              <div className="timeframe-row" aria-label="date range">
                {chartRanges.map((item) => (
                  <button
                    key={item}
                    className={!customVisibleCandleCount && item === chartRange ? 'active range-active' : ''}
                    onClick={() => selectChartRange(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>

              <div className="timeframe-row" aria-label="candle interval">
                {timeframes.map((item) => (
                  <button
                    key={item}
                    className={item === timeframe ? 'active' : item === effectiveTimeframe ? 'effective' : ''}
                    onClick={() => selectTimeframe(item)}
                    title={
                      dexscreenerMode
                        ? `${item} candles. Dexscreener mode keeps this interval and compresses missing timestamps.`
                        : `${item} candles. Minimum for ${chartRange}: ${getMinimumTimeframeForRange(chartRange)}`
                    }
                  >
                    {item}
                  </button>
                ))}
              </div>

              <div className="refresh-row">
                <button
                  className="refresh-moralis-button"
                  onClick={() => void refreshFromMoralis()}
                  disabled={refreshingFromMoralis}
                  title="Fetch this chart window directly from Moralis and overwrite cached candles"
                >
                  {refreshingFromMoralis ? 'Refreshing...' : 'Refresh From Moralis'}
                </button>
              </div>
            </div>
          </div>

          <ChartPanel
            candles={response?.candles ?? []}
            error={error}
            loading={loading || refreshingFromMoralis}
            emptyTitle={getEmptyChartTitle(response)}
            emptySubtitle={getEmptyChartSubtitle(response, chartRange, timeframe)}
            historyProgressPct={response?.historyProgressPct ?? null}
            debugColors={debugColors}
            effectiveTimeframe={effectiveTimeframe}
            visibleRange={visibleRange}
            visibleCandleCount={visibleCandleCount}
            visibleRangeRevision={visibleRangeRevision}
            onVisibleRangeChange={handleVisibleRangeChange}
            onVisibleLogicalRangeChange={handleVisibleLogicalRangeChange}
            historyWarmup={showHistoryWarmup}
            showFilledCandles={showEveryCandle}
            dexscreenerMode={dexscreenerMode}
            scrollModeEnabled={scrollModeEnabled}
            syntheticMode={syntheticMode}
          />

          <footer className="chart-footer">
            <span>
              {showHistoryWarmup
                ? 'Warming full market history...'
                : refreshingFromMoralis
                  ? 'Refreshing candles from Moralis...'
                : loading
                  ? 'Loading cached candles...'
                  : 'Realtime test terminal'}
            </span>
            <span>
              {showHistoryWarmup
                ? 'Preparing full candle history before rendering chart'
                : refreshingFromMoralis
                  ? 'Overwriting the current chart window with fresh Moralis candles'
                : error ??
                (dexscreenerMode
                  ? `${filledCandleCount} missing intervals compressed`
                  : response?.partial
                    ? showEveryCandle
                      ? `${filledCandleCount} filler intervals shown`
                      : `${filledCandleCount} filler intervals hidden`
                    : timeframe === effectiveTimeframe
                      ? 'Backend cache path active'
                      : `${timeframe} requested, showing ${effectiveTimeframe}`)}
            </span>
          </footer>
        </section>

        <aside className="trade-ticket">
          <div className="wallet-card">
            <span>Test Wallet</span>
            <strong>$0</strong>
            <small>Connect a wallet in the real app to enable execution.</small>
          </div>

          <div className="side-toggle">
            <button className={side === 'buy' ? 'selected' : ''} onClick={() => setSide('buy')}>
              Buy Pump
            </button>
            <button className={side === 'sell' ? 'selected danger-tab' : ''} onClick={() => setSide('sell')}>
              Sell Dump
            </button>
          </div>

          <label className="field">
            <span>Market</span>
            <select value={chain} onChange={(event) => setChain(event.target.value)}>
              {chainOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Pair address</span>
            <input value={pairAddress} onChange={(event) => setPairAddress(event.target.value)} />
          </label>

          <label className="field">
            <span>Amount USD</span>
            <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" />
          </label>

          <div className="slippage-card">
            <div>
              <span>Slippage</span>
              <strong>{slippage}%</strong>
            </div>
            <input
              type="range"
              min="1"
              max="50"
              value={slippage}
              onChange={(event) => setSlippage(Number(event.target.value))}
            />
            <div className="quick-pills">
              {[10, 25, 35, 50].map((value) => (
                <button key={value} onClick={() => setSlippage(value)}>
                  {value}%
                </button>
              ))}
            </div>
          </div>

          <button className={`execute-button ${side}`}>
            {side === 'buy' ? 'Get Started' : 'Prepare Sell'}
          </button>

          <div className="ticket-meta">
            <span>Route</span>
            <strong>Cache API → Moralis gaps</strong>
          </div>
        </aside>
      </section>
    </main>
  );
}

function getVisibleCandleCountForWindow(range: { from: Date; to: Date }, candleTimeframe: Timeframe) {
  const count = Math.ceil(getTimeWindowSpanMs(range) / getTimeframeDurationMs(candleTimeframe));

  return clampNumber(count, MIN_VISIBLE_CANDLE_COUNT, MAX_VISIBLE_CANDLE_COUNT);
}

function getVisibleWindowForCandleCount(count: number, candleTimeframe: Timeframe, anchorTo: Date) {
  const to = new Date(Math.min(anchorTo.getTime(), Date.now()));
  const spanMs = count * getTimeframeDurationMs(candleTimeframe);

  return {
    from: new Date(to.getTime() - spanMs),
    to,
  };
}

function parseVisibleCandleCount(value: string) {
  if (value.trim() === '') {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.trunc(parsed);
}

function getMaxVisibleCandleCountWithoutTimeframeChange(timeframe: Timeframe) {
  const anchor = new Date('2026-01-01T00:00:00.000Z');
  let low = MIN_VISIBLE_CANDLE_COUNT;
  let high = MAX_VISIBLE_CANDLE_COUNT;
  let best = MIN_VISIBLE_CANDLE_COUNT;

  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const spanMs = midpoint * getTimeframeDurationMs(timeframe);
    const candidateRange = {
      from: new Date(anchor.getTime() - spanMs),
      to: anchor,
    };

    if (getEffectiveTimeframeForWindow(timeframe, candidateRange) === timeframe) {
      best = midpoint;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return best;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getEmptyChartTitle(response: ChartResponse | null) {
  if (!response) {
    return 'No chart response yet';
  }

  if (response.candles.length === 0 && response.historyComplete) {
    return 'No candles returned for this window';
  }

  return 'No candles loaded yet';
}

function getEmptyChartSubtitle(response: ChartResponse | null, chartRange: ChartRange, timeframe: Timeframe) {
  if (!response) {
    return 'Waiting for the first cache lookup to finish.';
  }

  if (response.candles.length === 0) {
    return `Cache/provider returned 0 ${timeframe} candles for ${chartRange}. Try a smaller candle size or Refresh From Moralis.`;
  }

  return 'Start the backend or choose a shorter range.';
}

function getChartRouteFromLocation() {
  const [, maybeChain, maybePairAddress] = window.location.pathname.split('/');
  const searchParams = new URLSearchParams(window.location.search);
  const maybeTimeframe =
    normalizeTimeframeParam(searchParams.get('timeframe')) ??
    normalizeTimeframeParam(searchParams.get('candleSize'));
  const maybeChartRange =
    normalizeChartRangeParam(searchParams.get('range')) ??
    normalizeChartRangeParam(searchParams.get('chartRange'));
  const legacyTimeframeAsRange = normalizeChartRangeParam(searchParams.get('timeframe'));
  const visibleCandleCount = normalizeVisibleCandleCountParam(
    searchParams.get('visibleCandles') ??
      searchParams.get('visibleCandleCount') ??
      searchParams.get('candles')
  );
  const chain = maybeChain && VALID_CHAINS.has(maybeChain) ? maybeChain : DEFAULT_CHAIN;
  const pairAddress = maybePairAddress ? decodeURIComponent(maybePairAddress) : DEFAULT_PAIR;

  return {
    chain,
    pairAddress,
    timeframe: maybeTimeframe ?? DEFAULT_TIMEFRAME,
    chartRange: maybeChartRange ?? legacyTimeframeAsRange ?? DEFAULT_CHART_RANGE,
    dexscreenerMode:
      normalizeBooleanParam(searchParams.get('dexscreener') ?? searchParams.get('dexscreenerMode')) ?? false,
    scrollModeEnabled:
      normalizeBooleanParam(searchParams.get('scroll') ?? searchParams.get('scrollMode')) ?? false,
    syntheticMode:
      normalizeBooleanParam(searchParams.get('synthetic') ?? searchParams.get('syntheticMode')) ?? false,
    showEveryCandle:
      normalizeBooleanParam(searchParams.get('showEveryCandle') ?? searchParams.get('showFilledCandles')) ?? true,
    adaptiveZoomEnabled:
      normalizeBooleanParam(searchParams.get('zooming') ?? searchParams.get('adaptiveZoom')) ?? true,
    visibleCandleCount,
  };
}

function updateChartRoute(params: {
  chain: string;
  pairAddress: string;
  timeframe: Timeframe;
  chartRange: ChartRange;
  dexscreenerMode: boolean;
  scrollModeEnabled: boolean;
  syntheticMode: boolean;
  showEveryCandle: boolean;
  adaptiveZoomEnabled: boolean;
  visibleCandleCount: number | null;
}) {
  const trimmedPairAddress = params.pairAddress.trim();

  if (!VALID_CHAINS.has(params.chain) || !trimmedPairAddress) {
    return;
  }

  const nextPath = `/${params.chain}/${encodeURIComponent(trimmedPairAddress)}`;
  const searchParams = new URLSearchParams();
  searchParams.set('range', params.chartRange);
  searchParams.set('timeframe', params.timeframe);
  if (params.dexscreenerMode) {
    searchParams.set('dexscreener', '1');
  }
  if (params.scrollModeEnabled) {
    searchParams.set('scroll', '1');
  }
  if (params.syntheticMode) {
    searchParams.set('synthetic', '1');
  }
  if (!params.showEveryCandle) {
    searchParams.set('showEveryCandle', '0');
  }
  if (!params.adaptiveZoomEnabled) {
    searchParams.set('zooming', '0');
  }
  if (params.visibleCandleCount !== null) {
    searchParams.set('visibleCandles', String(params.visibleCandleCount));
  }
  const nextUrl = `${nextPath}?${searchParams.toString()}${window.location.hash}`;

  if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== nextUrl) {
    window.history.replaceState(null, '', nextUrl);
  }
}

function normalizeTimeframeParam(value: string | null): Timeframe | null {
  if (!value) {
    return null;
  }

  const normalized = value.toLowerCase();
  const aliases: Record<string, Timeframe> = {
    '1m': '1min',
    '5m': '5min',
    '10m': '10min',
    '30m': '30min',
    '1h': '1h',
    '4h': '4h',
    '12h': '12h',
    '1d': '1d',
    '1day': '1d',
  };
  const candidate = aliases[normalized] ?? normalized;

  return VALID_TIMEFRAMES.has(candidate as Timeframe) ? (candidate as Timeframe) : null;
}

function normalizeChartRangeParam(value: string | null): ChartRange | null {
  if (!value) {
    return null;
  }

  const normalized = value.toUpperCase().replace(/[_\s]+/g, '');
  const aliases: Record<string, ChartRange> = {
    ALL: 'ALL',
    MAX: 'ALL',
  };
  const candidate = aliases[normalized] ?? normalized;

  return VALID_CHART_RANGES.has(candidate as ChartRange) ? (candidate as ChartRange) : null;
}

function normalizeBooleanParam(value: string | null): boolean | null {
  if (!value) {
    return null;
  }

  const normalized = value.toLowerCase();

  if (['1', 'true', 'on', 'yes'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'off', 'no'].includes(normalized)) {
    return false;
  }

  return null;
}

function normalizeVisibleCandleCountParam(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = parseVisibleCandleCount(value);

  return parsed === null ? null : clampNumber(parsed, MIN_VISIBLE_CANDLE_COUNT, MAX_VISIBLE_CANDLE_COUNT);
}

function getPreferredRangeForTimeframe(timeframe: Timeframe, currentRange: ChartRange): ChartRange {
  switch (timeframe) {
    case '1min':
      return '1H';
    case '5min':
      return '4H';
    case '10min':
      return '8H';
    case '30min':
      return '24H';
    case '1h':
      return '48H';
    case '4h':
      return '7D';
    case '12h':
      return '30D';
    case '1d':
      return '2M';
    default:
      return currentRange;
  }
}

function shortenAddress(value: string) {
  const trimmed = value.trim();

  if (trimmed.length <= 12) {
    return trimmed || 'Pair';
  }

  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

function areTimeWindowsClose(left: { from: Date; to: Date }, right: { from: Date; to: Date }) {
  const toleranceMs = 30_000;

  return (
    Math.abs(left.from.getTime() - right.from.getTime()) < toleranceMs &&
    Math.abs(left.to.getTime() - right.to.getTime()) < toleranceMs
  );
}

function getTimeWindowSpanMs(range: { from: Date; to: Date }) {
  return Math.max(0, range.to.getTime() - range.from.getTime());
}

function clampRangeToNow(range: { from: Date; to: Date }) {
  const nowMs = Date.now();
  const toMs = range.to.getTime();

  if (toMs <= nowMs) {
    return range;
  }

  const overflowMs = toMs - nowMs;

  return {
    from: new Date(range.from.getTime() - overflowMs),
    to: new Date(nowMs),
  };
}

function logInteraction(payload: {
  interactionId: string;
  event: 'chart_range_click' | 'candle_resolution_click' | 'refresh_from_moralis_click';
  selectedValue: string;
  previousValue?: string | undefined;
  chain: string;
  pairAddress: string;
  requestedTimeframe: string;
  effectiveTimeframe: string;
  chartRange: string;
  visibleFrom: string;
  visibleTo: string;
  loadedCandles?: number | undefined;
  source?: string | undefined;
  nextChartRange?: string | undefined;
  nextVisibleFrom?: string | undefined;
  nextVisibleTo?: string | undefined;
}) {
  void fetch('/api/debug/interactions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  }).catch(() => undefined);
}

function createInteractionId() {
  return `click_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
