import { useEffect, useMemo, useState } from 'react';
import { ChartPanel } from './ChartPanel';
import {
  fetchChartCandles,
  fetchPairMetadata,
  fetchMoralisUsage,
  getMinimumTimeframeForRange,
  getRangeWindow,
  getSafeTimeframeForRange,
  isTimeframeAllowedForRange,
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
const chartRanges: ChartRange[] = ['24H', '7D', '30D', '3M', '6M', '1Y', 'ALL'];

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

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const range = getRangeWindow(chartRange);
        const chartResponse = await fetchChartCandles({
          chain,
          pairAddress,
          timeframe,
          ...range,
        });

        if (!controller.signal.aborted) {
          setResponse(chartResponse);
        }
      } catch (loadError) {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load chart');
          setResponse(null);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => controller.abort();
  }, [chain, pairAddress, timeframe, chartRange]);

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

  function selectChartRange(nextRange: ChartRange) {
    setChartRange(nextRange);
    setTimeframe((current) => getSafeTimeframeForRange(nextRange, current));
  }

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
          <button className="connect-button">Connect Log In</button>
        </div>
      </header>

      <section className="ticker-tape" aria-label="market tape">
        {[
          ['Market', getChainLabel(chain)],
          [pairMetadata?.baseSymbol ?? 'Pair', lastCandle ? `$${lastCandle.close.toFixed(8)}` : 'loading'],
          ['Source', response?.source ?? 'none'],
          ['Candles', String(response?.candles.length ?? 0)],
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
                    className={item === timeframe ? 'active' : ''}
                    disabled={!isTimeframeAllowedForRange(chartRange, item)}
                    onClick={() => setTimeframe(item)}
                    title={
                      !isTimeframeAllowedForRange(chartRange, item)
                        ? `${item} is too granular for ${chartRange}. Minimum: ${getMinimumTimeframeForRange(chartRange)}`
                        : `${item} candles`
                    }
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <ChartPanel candles={response?.candles ?? []} error={error} />

          <footer className="chart-footer">
            <span>{loading ? 'Loading cached candles...' : 'Realtime test terminal'}</span>
            <span>{error ?? (response?.partial ? 'Backfill queued for missing candles' : 'Backend cache path active')}</span>
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

function shortenAddress(value: string) {
  const trimmed = value.trim();

  if (trimmed.length <= 12) {
    return trimmed || 'Pair';
  }

  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}
