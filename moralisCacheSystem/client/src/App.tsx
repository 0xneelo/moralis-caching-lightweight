import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChartPanel } from './ChartPanel';
import {
  fetchChartCandles,
  fetchPairMetadata,
  fetchMoralisUsage,
  getEffectiveTimeframeForWindow,
  getMinimumTimeframeForRange,
  getPrefetchWindow,
  getRangeWindow,
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
const INITIAL_CHART_ROUTE = getChartRouteFromLocation();
const CHART_FETCH_DEBOUNCE_MS = 150;
const CHART_ZOOM_DEBOUNCE_MS = 500;
const IGNORE_CHART_RANGE_AFTER_CLICK_MS = 1_500;

type Side = 'buy' | 'sell';

export function App() {
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
  const [visibleRange, setVisibleRange] = useState(() => getRangeWindow(INITIAL_CHART_ROUTE.chartRange));
  const [visibleRangeRevision, setVisibleRangeRevision] = useState(0);
  const [activeInteractionId, setActiveInteractionId] = useState<string | undefined>();
  const zoomDebounceRef = useRef<number | null>(null);
  const ignoreChartRangeUntilRef = useRef(0);
  const effectiveTimeframe = useMemo(
    () => getEffectiveTimeframeForWindow(timeframe, visibleRange),
    [timeframe, visibleRange]
  );
  const loadRange = useMemo(
    () => getPrefetchWindow(visibleRange, effectiveTimeframe),
    [effectiveTimeframe, visibleRange]
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
    updateChartRoute({ chain, pairAddress, timeframe, chartRange });
  }, [chain, pairAddress, timeframe, chartRange]);

  useEffect(() => {
    function handlePopState() {
      const route = getChartRouteFromLocation();
      setChain(route.chain);
      setPairAddress(route.pairAddress);
      setTimeframe(route.timeframe);
      setChartRange(route.chartRange);
      setVisibleRange(getRangeWindow(route.chartRange));
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
  }, [activeInteractionId, chain, loadRange, pairAddress, timeframe]);

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
    setChartRange(nextRange);
    setVisibleRange(nextVisibleRange);
    setVisibleRangeRevision((current) => current + 1);
  }

  function selectTimeframe(nextTimeframe: Timeframe) {
    clearPendingZoomUpdate();
    ignoreChartRangeUntilRef.current = Date.now() + IGNORE_CHART_RANGE_AFTER_CLICK_MS;
    const interactionId = createInteractionId();
    const nextChartRange = getPreferredRangeForTimeframe(nextTimeframe, chartRange);
    const nextVisibleRange = getRangeWindow(nextChartRange);
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
    setVisibleRangeRevision((current) => current + 1);
    setTimeframe(nextTimeframe);
  }

  const refreshFromMoralis = useCallback(async () => {
    const interactionId = createInteractionId();
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
      setRefreshingFromMoralis(false);
      setLoading(false);
    }
  }, [chain, chartRange, effectiveTimeframe, pairAddress, response, timeframe, visibleRange]);

  const handleVisibleRangeChange = useCallback((nextRange: { from: Date; to: Date }) => {
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

        // Chart redraws can emit narrower ranges as data changes. Only user zoom-out
        // should expand the active range and trigger coarser candle adaptation.
        if (nextSpanMs <= currentSpanMs * 1.1) {
          return current;
        }

        return clampedRange;
      });
      zoomDebounceRef.current = null;
    }, CHART_ZOOM_DEBOUNCE_MS);
  }, []);

  useEffect(
    () => () => {
      if (zoomDebounceRef.current !== null) {
        window.clearTimeout(zoomDebounceRef.current);
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
            className={debugColors ? 'mode-toggle active' : 'mode-toggle'}
            onClick={() => setDebugColors((current) => !current)}
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
          {['+', '⌖', '≋', '⌁', '↕', '◰', '◎', '⌫'].map((tool) => (
            <button key={tool}>{tool}</button>
          ))}
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
                    className={item === chartRange ? 'active range-active' : ''}
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
                    title={`${item} candles. Minimum for ${chartRange}: ${getMinimumTimeframeForRange(chartRange)}`}
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
            candles={showHistoryWarmup ? [] : (response?.candles ?? [])}
            error={showHistoryWarmup ? null : error}
            loading={loading || refreshingFromMoralis}
            emptyTitle={getEmptyChartTitle(response)}
            emptySubtitle={getEmptyChartSubtitle(response, chartRange, timeframe)}
            historyProgressPct={response?.historyProgressPct ?? null}
            debugColors={debugColors}
            effectiveTimeframe={effectiveTimeframe}
            visibleRange={visibleRange}
            visibleRangeRevision={visibleRangeRevision}
            onVisibleRangeChange={handleVisibleRangeChange}
            historyWarmup={showHistoryWarmup}
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
                (response?.partial
                  ? `${filledCandleCount} missing intervals hidden from chart`
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
  const chain = maybeChain && VALID_CHAINS.has(maybeChain) ? maybeChain : DEFAULT_CHAIN;
  const pairAddress = maybePairAddress ? decodeURIComponent(maybePairAddress) : DEFAULT_PAIR;

  return {
    chain,
    pairAddress,
    timeframe: maybeTimeframe ?? DEFAULT_TIMEFRAME,
    chartRange: maybeChartRange ?? legacyTimeframeAsRange ?? DEFAULT_CHART_RANGE,
  };
}

function updateChartRoute(params: {
  chain: string;
  pairAddress: string;
  timeframe: Timeframe;
  chartRange: ChartRange;
}) {
  const trimmedPairAddress = params.pairAddress.trim();

  if (!VALID_CHAINS.has(params.chain) || !trimmedPairAddress) {
    return;
  }

  const nextPath = `/${params.chain}/${encodeURIComponent(trimmedPairAddress)}`;
  const searchParams = new URLSearchParams();
  searchParams.set('range', params.chartRange);
  searchParams.set('timeframe', params.timeframe);
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

