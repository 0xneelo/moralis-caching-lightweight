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

const timeframes: Timeframe[] = ['1min', '5min', '10min', '30min', '1h', '4h', '12h', '1d'];
const chartRanges: ChartRange[] = ['1H', '4H', '8H', '12H', '24H', '48H', '7D', '30D', '2M', '3M', '6M', '1Y', 'ALL'];
const CHART_FETCH_DEBOUNCE_MS = 600;
const CHART_ZOOM_DEBOUNCE_MS = 500;
const IGNORE_CHART_RANGE_AFTER_CLICK_MS = 1_500;

type Side = 'buy' | 'sell';

export function App() {
  const [pairAddress, setPairAddress] = useState(DEFAULT_PAIR);
  const [chain, setChain] = useState(DEFAULT_CHAIN);
  const [timeframe, setTimeframe] = useState<Timeframe>('1h');
  const [chartRange, setChartRange] = useState<ChartRange>('30D');
  const [side, setSide] = useState<Side>('buy');
  const [amount, setAmount] = useState('1000');
  const [slippage, setSlippage] = useState(10);
  const [response, setResponse] = useState<ChartResponse | null>(null);
  const [usage, setUsage] = useState<MoralisUsage | null>(null);
  const [pairMetadata, setPairMetadata] = useState<PairMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [debugColors, setDebugColors] = useState(true);
  const [visibleRange, setVisibleRange] = useState(() => getRangeWindow('30D'));
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

  const handleVisibleRangeChange = useCallback((nextRange: { from: Date; to: Date }) => {
    if (Date.now() < ignoreChartRangeUntilRef.current) {
      return;
    }

    if (zoomDebounceRef.current !== null) {
      window.clearTimeout(zoomDebounceRef.current);
    }

    zoomDebounceRef.current = window.setTimeout(() => {
      setVisibleRange((current) => {
        if (areTimeWindowsClose(current, nextRange)) {
          return current;
        }

        const currentSpanMs = getTimeWindowSpanMs(current);
        const nextSpanMs = getTimeWindowSpanMs(nextRange);

        // Chart redraws can emit narrower ranges as data changes. Only user zoom-out
        // should expand the active range and trigger coarser candle adaptation.
        if (nextSpanMs <= currentSpanMs * 1.1) {
          return current;
        }

        return nextRange;
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
          ['Loaded', String(response?.candles.length ?? 0)],
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
            </div>
          </div>

          <ChartPanel
            candles={response?.candles ?? []}
            error={error}
            timeframe={effectiveTimeframe}
            debugColors={debugColors}
            visibleRange={visibleRange}
            visibleRangeRevision={visibleRangeRevision}
            onVisibleRangeChange={handleVisibleRangeChange}
          />

          <footer className="chart-footer">
            <span>{loading ? 'Loading cached candles...' : 'Realtime test terminal'}</span>
            <span>
              {error ??
                (response?.partial
                  ? 'Partial real candles returned; remaining gaps protected'
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

function logInteraction(payload: {
  interactionId: string;
  event: 'chart_range_click' | 'candle_resolution_click';
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

