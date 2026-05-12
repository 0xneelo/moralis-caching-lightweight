import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  createAdminExternalApiKey,
  downloadAdminCacheSnapshot,
  fetchAdminDashboard,
  importAdminCacheSnapshot,
  loadAdminPersistentCache,
  revokeAdminExternalApiKey,
  updateAdminSettings,
  type AdminDashboard as AdminDashboardData,
  type AdminSettings,
} from './api';

type AdminPage = 'overview' | 'apis' | 'cache' | 'settings';
type NumericAdminSettingKey =
  | 'moralisDailyCuBudget'
  | 'maxSyncMoralisPages'
  | 'maxSyncGapCandles'
  | 'externalApiKeyRequestRateLimit'
  | 'externalApiKeyCacheMissRateLimit'
  | 'externalApiKeyDailyCuBudget';

const ADMIN_KEY_STORAGE = 'moralis_cache_admin_key';
const pages: Array<{ id: AdminPage; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'apis', label: 'APIs' },
  { id: 'cache', label: 'Cache' },
  { id: 'settings', label: 'Settings' },
];

const numericSettings: Array<{ key: NumericAdminSettingKey; label: string }> = [
  { key: 'moralisDailyCuBudget', label: 'Moralis daily CU budget' },
  { key: 'maxSyncMoralisPages', label: 'Max Moralis pages per sync' },
  { key: 'maxSyncGapCandles', label: 'Max sync gap candles' },
  { key: 'externalApiKeyRequestRateLimit', label: 'External key requests per minute' },
  { key: 'externalApiKeyCacheMissRateLimit', label: 'External key cache misses per minute' },
  { key: 'externalApiKeyDailyCuBudget', label: 'External key daily CU budget' },
];

export function AdminDashboard() {
  const [adminKey, setAdminKey] = useState(() => localStorage.getItem(ADMIN_KEY_STORAGE) ?? '');
  const [draftAdminKey, setDraftAdminKey] = useState(adminKey);
  const [data, setData] = useState<AdminDashboardData | null>(null);
  const [activePage, setActivePage] = useState<AdminPage>(() => getAdminPageFromLocation());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [loadingPersistentCache, setLoadingPersistentCache] = useState(false);
  const [exportingCache, setExportingCache] = useState(false);
  const [importingCache, setImportingCache] = useState(false);

  useEffect(() => {
    if (window.location.pathname === '/admin') {
      window.history.replaceState(null, '', '/admin/overview');
    }

    function handlePopState() {
      setActivePage(getAdminPageFromLocation());
    }

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timeout = window.setTimeout(() => setToast(null), 2_800);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [toast]);

  useEffect(() => {
    if (!adminKey) {
      return;
    }

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const dashboard = await fetchAdminDashboard(adminKey);
        if (!cancelled) {
          setData(dashboard);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load admin dashboard');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    const interval = window.setInterval(load, 10_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [adminKey]);

  function login() {
    const trimmed = draftAdminKey.trim();
    localStorage.setItem(ADMIN_KEY_STORAGE, trimmed);
    setAdminKey(trimmed);
  }

  function logout() {
    localStorage.removeItem(ADMIN_KEY_STORAGE);
    setAdminKey('');
    setDraftAdminKey('');
    setData(null);
  }

  async function saveSettings(patch: Partial<AdminSettings>) {
    if (!data) return;
    const changed = getChangedSettings(data.settings, patch);
    const settings = await updateAdminSettings(adminKey, patch);
    setData({ ...data, settings });
    setToast(changed.length > 0 ? `Saved: ${changed.join(', ')}` : 'No config changes');
  }

  async function createApiKey(name: string) {
    const result = await createAdminExternalApiKey(adminKey, name);
    setCreatedKey(result.apiKey);
    const dashboard = await fetchAdminDashboard(adminKey);
    setData(dashboard);
  }

  async function revokeApiKey(id: string) {
    await revokeAdminExternalApiKey(adminKey, id);
    const dashboard = await fetchAdminDashboard(adminKey);
    setData(dashboard);
  }

  async function loadPersistentCache() {
    if (!data || loadingPersistentCache) {
      return;
    }

    setLoadingPersistentCache(true);
    setError(null);
    try {
      const result = await loadAdminPersistentCache(adminKey);
      setData({
        ...data,
        runtimeMode: result.mode,
        cacheInventory: result.markets,
        updatedAt: new Date().toISOString(),
      });
      setToast(
        result.importedMarkets > 0
          ? `Loaded ${formatNumber(result.importedMarkets)} market rows from persistent cache`
          : 'Persistent cache is reachable, but no market rows were found'
      );
    } catch (loadError) {
      const message =
        loadError instanceof Error ? loadError.message : 'Failed to load persistent cache inventory';
      setError(message);
      setToast(`Load failed: ${message}`);
    } finally {
      setLoadingPersistentCache(false);
    }
  }

  async function exportCacheSnapshot() {
    if (exportingCache) {
      return;
    }

    setExportingCache(true);
    setError(null);
    try {
      const result = await downloadAdminCacheSnapshot(adminKey);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setToast(`Downloaded ${result.filename}`);
    } catch (exportError) {
      const message = exportError instanceof Error ? exportError.message : 'Failed to export cache snapshot';
      setError(message);
      setToast(`Export failed: ${message}`);
    } finally {
      setExportingCache(false);
    }
  }

  async function importCacheSnapshot(snapshot: unknown) {
    if (!data || importingCache) {
      return;
    }

    setImportingCache(true);
    setError(null);
    try {
      const result = await importAdminCacheSnapshot(adminKey, snapshot);
      setData({
        ...data,
        cacheInventory: result.markets,
        updatedAt: new Date().toISOString(),
      });
      setToast(
        `Imported ${formatNumber(result.importedCandles)} candles across ${formatNumber(result.importedMarkets)} markets`
      );
    } catch (importError) {
      const message = importError instanceof Error ? importError.message : 'Failed to import cache snapshot';
      setError(message);
      setToast(`Import failed: ${message}`);
    } finally {
      setImportingCache(false);
    }
  }

  function reportCacheTransferError(message: string) {
    setError(message);
    setToast(`Import failed: ${message}`);
  }

  function selectPage(page: AdminPage) {
    setActivePage(page);
    window.history.pushState(null, '', `/admin/${page}`);
  }

  if (!adminKey || !data) {
    return (
      <main className="admin-shell admin-login-shell">
        <section className="admin-login">
          <div className="brand-lockup">
            <div className="brand-mark">M</div>
            <div>
              <strong>Moralis Cache Admin</strong>
              <span>Internal controls and usage visibility</span>
            </div>
          </div>
          <label className="admin-field">
            <span>Admin key</span>
            <input
              value={draftAdminKey}
              onChange={(event) => setDraftAdminKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') login();
              }}
              type="password"
              autoFocus
            />
          </label>
          {error ? <p className="admin-error">{error}</p> : null}
          <button className="admin-primary" onClick={login} disabled={!draftAdminKey.trim() || loading}>
            {loading ? 'Checking...' : 'Log in'}
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="admin-shell">
      <aside className="admin-sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">M</div>
          <div>
            <strong>Cache Admin</strong>
            <span>{formatTime(data.updatedAt)}</span>
          </div>
        </div>
        <nav className="admin-nav">
          {pages.map((page) => (
            <button
              key={page.id}
              className={activePage === page.id ? 'active' : ''}
              onClick={() => selectPage(page.id)}
            >
              {page.label}
            </button>
          ))}
        </nav>
        <a className="admin-link" href="/">
          Chart terminal
        </a>
        <button className="admin-link" onClick={logout}>
          Log out
        </button>
      </aside>

      <section className="admin-main">
        <header className="admin-header">
          <div>
            <span className="admin-eyebrow">Internal operations</span>
            <h1>{pages.find((page) => page.id === activePage)?.label}</h1>
          </div>
          <div className="admin-header-statuses">
            <div className={`admin-runtime-tag ${data.runtimeMode === 'local-memory' ? 'local' : 'persistent'}`}>
              {data.runtimeMode === 'local-memory'
                ? 'Mode: local-memory'
                : data.runtimeMode === 'persistent-snapshot'
                  ? 'Mode: persistent snapshot'
                  : 'Mode: persistent'}
            </div>
            <div className={data.settings.moralisOhlcvEnabled ? 'admin-status ok' : 'admin-status danger'}>
              {data.settings.moralisOhlcvEnabled ? 'Moralis enabled' : 'Moralis disabled'}
            </div>
          </div>
        </header>
        {error ? <p className="admin-error">{error}</p> : null}
        {activePage === 'overview' ? <OverviewPage data={data} /> : null}
        {activePage === 'apis' ? (
          <ApisPage data={data} createdKey={createdKey} onCreate={createApiKey} onRevoke={revokeApiKey} />
        ) : null}
        {activePage === 'cache' ? (
          <CachePage
            data={data}
            onLoadPersistentCache={loadPersistentCache}
            onExportCache={exportCacheSnapshot}
            onImportCache={importCacheSnapshot}
            onImportError={reportCacheTransferError}
            loadingPersistentCache={loadingPersistentCache}
            exportingCache={exportingCache}
            importingCache={importingCache}
          />
        ) : null}
        {activePage === 'settings' ? <SettingsPage data={data} onSave={saveSettings} /> : null}
      </section>
      {toast ? <div className="admin-toast">{toast}</div> : null}
    </main>
  );
}

function OverviewPage({ data }: { data: AdminDashboardData }) {
  const cuPct = Math.min(100, Math.round((data.usage.todayCu / data.settings.moralisDailyCuBudget) * 100));

  return (
    <div className="admin-page">
      <section className="admin-metrics">
        <Metric label="Today CU" value={formatNumber(data.usage.todayCu)} detail={`${cuPct}% of daily budget`} />
        <Metric label="Today requests" value={formatNumber(data.usage.todayRequests)} detail="Moralis provider calls" />
        <Metric label="Total CU" value={formatNumber(data.usage.totalCu)} detail="All recorded usage" />
        <Metric label="Cache markets" value={formatNumber(data.cacheInventory.length)} detail="Tracked market/timeframes" />
      </section>

      <section className="admin-two-column">
        <div className="admin-panel">
          <h2>CU trend</h2>
          <BarChart rows={data.breakdown.hourly24h.map((row) => ({ label: formatHour(row.hour), value: row.estimatedCu }))} />
        </div>
        <div className="admin-panel">
          <h2>Top endpoints</h2>
          <DataTable
            columns={['Endpoint', 'Requests', 'CU', 'Errors']}
            rows={data.breakdown.endpoints24h.map((row) => [
              row.endpoint,
              formatNumber(row.requestCount),
              formatNumber(row.estimatedCu),
              formatNumber(row.errorCount),
            ])}
          />
        </div>
      </section>

      <div className="admin-panel">
        <h2>Recent throttle events</h2>
        <DataTable
          columns={['Time', 'Reason', 'Market', 'Window']}
          rows={data.throttleEvents.map((event) => [
            formatTime(event.timestamp),
            event.reason,
            `${event.chain ?? '-'} ${shorten(event.pairAddress)}`,
            event.requestFrom && event.requestTo ? `${formatDate(event.requestFrom)} to ${formatDate(event.requestTo)}` : '-',
          ])}
        />
      </div>
    </div>
  );
}

function ApisPage({
  data,
  createdKey,
  onCreate,
  onRevoke,
}: {
  data: AdminDashboardData;
  createdKey: string | null;
  onCreate: (name: string) => Promise<void>;
  onRevoke: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState('');

  return (
    <div className="admin-page">
      <div className="admin-panel admin-form-row">
        <label className="admin-field">
          <span>New external service key</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Service name" />
        </label>
        <button
          className="admin-primary"
          onClick={() => {
            void onCreate(name.trim());
            setName('');
          }}
          disabled={!name.trim()}
        >
          Create key
        </button>
      </div>
      {createdKey ? (
        <div className="admin-secret">
          <span>New key, shown once</span>
          <code>{createdKey}</code>
        </div>
      ) : null}
      <div className="admin-panel">
        <h2>External API keys</h2>
        <DataTable
          columns={['Name', 'Prefix', 'Requests', 'Last used', 'Status', '']}
          rows={data.apiKeys.map((key) => [
            key.name,
            key.keyPrefix,
            formatNumber(key.requestCount),
            key.lastUsedAt ? formatTime(key.lastUsedAt) : '-',
            key.active ? 'Active' : 'Revoked',
            key.active ? (
              <button className="admin-table-action" onClick={() => void onRevoke(key.id)}>
                Revoke
              </button>
            ) : (
              ''
            ),
          ])}
        />
      </div>
      <div className="admin-panel">
        <h2>Usage by key, 24h</h2>
        <DataTable
          columns={['Key', 'Requests', 'CU', 'Last seen']}
          rows={data.breakdown.externalKeys24h.map((row) => [
            row.apiKeyName ?? row.externalApiKeyId ?? 'Internal chart UI',
            formatNumber(row.requestCount),
            formatNumber(row.estimatedCu),
            row.lastSeenAt ? formatTime(row.lastSeenAt) : '-',
          ])}
        />
      </div>
    </div>
  );
}

function CachePage({
  data,
  onLoadPersistentCache,
  onExportCache,
  onImportCache,
  onImportError,
  loadingPersistentCache,
  exportingCache,
  importingCache,
}: {
  data: AdminDashboardData;
  onLoadPersistentCache: () => Promise<void>;
  onExportCache: () => Promise<void>;
  onImportCache: (snapshot: unknown) => Promise<void>;
  onImportError: (message: string) => void;
  loadingPersistentCache: boolean;
  exportingCache: boolean;
  importingCache: boolean;
}) {
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const totalCandles = data.cacheInventory.reduce((sum, market) => sum + market.candleCount, 0);
  const canLoadPersistent = data.runtimeMode !== 'persistent';

  async function handleImportFile(file: File | undefined) {
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      await onImportCache(JSON.parse(text));
    } catch (error) {
      onImportError(error instanceof Error ? error.message : 'Could not read cache snapshot file');
    }
  }

  return (
    <div className="admin-page">
      <div className="admin-cache-actions">
        <div className={`admin-runtime-tag ${data.runtimeMode === 'local-memory' ? 'local' : 'persistent'}`}>
          {data.runtimeMode === 'local-memory'
            ? 'Running in local-memory mode'
            : data.runtimeMode === 'persistent-snapshot'
              ? 'Using persistent snapshot + local updates'
              : 'Running with persistent cache'}
        </div>
        <div className="admin-cache-buttons">
          <button
            className="admin-table-action"
            onClick={() => void onExportCache()}
            disabled={exportingCache || importingCache}
          >
            {exportingCache ? 'Preparing download...' : 'Download cache'}
          </button>
          <button
            className="admin-table-action"
            onClick={() => importInputRef.current?.click()}
            disabled={exportingCache || importingCache}
          >
            {importingCache ? 'Uploading cache...' : 'Upload cache'}
          </button>
          <input
            ref={importInputRef}
            className="admin-file-input"
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              void handleImportFile(event.target.files?.[0]).finally(() => {
                event.currentTarget.value = '';
              });
            }}
          />
          <button
            className="admin-table-action"
            onClick={() => void onLoadPersistentCache()}
            disabled={!canLoadPersistent || loadingPersistentCache}
            title={
              canLoadPersistent
                ? 'Load persistent cache inventory from Postgres into this admin view'
                : 'Already connected to the persistent runtime'
            }
          >
            {loadingPersistentCache ? 'Loading persistent cache...' : 'Load persistent cache'}
          </button>
        </div>
      </div>
      <section className="admin-metrics">
        <Metric label="Markets" value={formatNumber(data.cacheInventory.length)} detail="Pair/timeframe/currency rows" />
        <Metric label="Candles" value={formatNumber(totalCandles)} detail="Cached OHLCV candles" />
        <Metric label="Newest cache" value={formatTime(data.cacheInventory[0]?.updatedAt)} detail="Latest updated market" />
      </section>
      <div className="admin-panel">
        <h2>Downloaded candle inventory</h2>
        {data.cacheInventory.length === 0 ? (
          <div className="admin-empty-state">
            <strong>No candle cache has been recorded yet</strong>
            <p>
              This table is populated from stored OHLCV candles. In local-memory mode it starts empty after a server
              restart, and in database mode it stays empty until a chart request or external API request causes candles
              to be fetched and written.
            </p>
            <div className="admin-guide-grid">
              <div>
                <span>1</span>
                <p>Open the chart terminal and load a pair/range that is not already cached.</p>
              </div>
              <div>
                <span>2</span>
                <p>Click Refresh From Moralis, or let an external service call the OHLCV compatibility API.</p>
              </div>
              <div>
                <span>3</span>
                <p>Keep Moralis enabled and make sure CU budgets and sync limits are high enough for the requested gap.</p>
              </div>
              <div>
                <span>4</span>
                <p>Refresh this page after the request completes. The market/timeframe row will appear here.</p>
              </div>
            </div>
          </div>
        ) : (
          <DataTable
            columns={['Chain', 'Pair', 'Timeframe', 'Candles', 'Coverage', 'Updated']}
            rows={data.cacheInventory.map((market) => [
              market.chain,
              shorten(market.pairAddress),
              `${market.timeframe} ${market.currency}`,
              formatNumber(market.candleCount),
              `${formatDate(market.firstCandleAt)} to ${formatDate(market.lastCandleAt)}`,
              formatTime(market.updatedAt),
            ])}
          />
        )}
      </div>
    </div>
  );
}

function SettingsPage({
  data,
  onSave,
}: {
  data: AdminDashboardData;
  onSave: (patch: Partial<AdminSettings>) => Promise<void>;
}) {
  const [draft, setDraft] = useState(data.settings);
  const [draftInputs, setDraftInputs] = useState(() => buildNumericDraftInputs(data.settings));
  const [saving, setSaving] = useState(false);
  const isDirty = !areSettingsEqual(draft, data.settings);

  useEffect(() => {
    if (isDirty) {
      return;
    }

    setDraft(data.settings);
    setDraftInputs(buildNumericDraftInputs(data.settings));
  }, [data.settings, isDirty]);

  function handleNumericInputChange(key: NumericAdminSettingKey, value: string) {
    const parsed = parseNumericSettingInput(value);
    setDraftInputs((current) => ({
      ...current,
      [key]: parsed === null ? '' : formatNumber(parsed),
    }));
    if (parsed !== null) {
      setDraft((current) => ({
        ...current,
        [key]: parsed,
      }));
    }
  }

  function handleNumericInputBlur(key: NumericAdminSettingKey) {
    setDraftInputs((current) => ({
      ...current,
      [key]: formatNumber(draft[key]),
    }));
  }

  async function handleSave() {
    if (saving) {
      return;
    }

    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-page">
      <div className="admin-panel admin-settings-grid">
        <label className="admin-toggle">
          <input
            type="checkbox"
            checked={draft.moralisOhlcvEnabled}
            onChange={(event) => setDraft({ ...draft, moralisOhlcvEnabled: event.target.checked })}
          />
          <span>Moralis OHLCV provider</span>
        </label>
        {numericSettings.map(({ key, label }) => (
          <label className="admin-field" key={key}>
            <span>{label}</span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={draftInputs[key]}
              onChange={(event) => handleNumericInputChange(key, event.target.value)}
              onBlur={() => handleNumericInputBlur(key)}
            />
          </label>
        ))}
      </div>
      <div className="admin-actions">
        <button className="admin-primary admin-save-button" onClick={() => void handleSave()} disabled={saving}>
          {saving ? 'Saving...' : 'Save settings'}
        </button>
      </div>
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="admin-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function BarChart({ rows }: { rows: Array<{ label: string; value: number }> }) {
  const max = Math.max(...rows.map((row) => row.value), 1);

  return (
    <div className="admin-bars">
      {(rows.length ? rows : [{ label: '-', value: 0 }]).map((row) => (
        <div key={row.label} className="admin-bar-row">
          <span>{row.label}</span>
          <div>
            <i style={{ width: `${Math.max(2, (row.value / max) * 100)}%` }} />
          </div>
          <strong>{formatNumber(row.value)}</strong>
        </div>
      ))}
    </div>
  );
}

function DataTable({ columns, rows }: { columns: string[]; rows: Array<Array<ReactNode>> }) {
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row, index) => (
              <tr key={index}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{cell}</td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={columns.length}>No data yet</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function formatNumber(value: number | undefined) {
  return new Intl.NumberFormat('en-US').format(value ?? 0);
}

function formatTime(value: string | null | undefined) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatDate(value: string | null | undefined) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(value));
}

function formatHour(value: string) {
  return new Intl.DateTimeFormat('en-US', { hour: '2-digit' }).format(new Date(value));
}

function shorten(value: string | null | undefined) {
  if (!value) return '-';
  return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

function getAdminPageFromLocation(): AdminPage {
  const candidate = window.location.pathname.split('/').filter(Boolean)[1];

  if (candidate === 'apis' || candidate === 'cache' || candidate === 'settings' || candidate === 'overview') {
    return candidate;
  }

  return 'overview';
}

function getChangedSettings(previous: AdminSettings, next: Partial<AdminSettings>) {
  const labels: Record<keyof AdminSettings, string> = {
    moralisOhlcvEnabled: 'Moralis OHLCV',
    moralisDailyCuBudget: 'Moralis daily CU',
    maxSyncMoralisPages: 'Max Moralis pages',
    maxSyncGapCandles: 'Max gap candles',
    externalApiKeyRequestRateLimit: 'External req/min',
    externalApiKeyCacheMissRateLimit: 'External misses/min',
    externalApiKeyDailyCuBudget: 'External daily CU',
  };

  return (Object.keys(labels) as Array<keyof AdminSettings>)
    .filter((key) => next[key] !== undefined && next[key] !== previous[key])
    .map((key) => `${labels[key]} -> ${formatSettingValue(next[key])}`);
}

function formatSettingValue(value: AdminSettings[keyof AdminSettings] | undefined) {
  if (typeof value === 'boolean') {
    return value ? 'enabled' : 'disabled';
  }

  return formatNumber(value);
}

function buildNumericDraftInputs(settings: AdminSettings): Record<NumericAdminSettingKey, string> {
  return {
    moralisDailyCuBudget: formatNumber(settings.moralisDailyCuBudget),
    maxSyncMoralisPages: formatNumber(settings.maxSyncMoralisPages),
    maxSyncGapCandles: formatNumber(settings.maxSyncGapCandles),
    externalApiKeyRequestRateLimit: formatNumber(settings.externalApiKeyRequestRateLimit),
    externalApiKeyCacheMissRateLimit: formatNumber(settings.externalApiKeyCacheMissRateLimit),
    externalApiKeyDailyCuBudget: formatNumber(settings.externalApiKeyDailyCuBudget),
  };
}

function parseNumericSettingInput(value: string) {
  const digitsOnly = value.replace(/[^\d]/g, '');
  if (!digitsOnly) {
    return null;
  }

  const parsed = Number(digitsOnly);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.max(1, Math.floor(parsed));
}

function areSettingsEqual(left: AdminSettings, right: AdminSettings) {
  return (
    left.moralisOhlcvEnabled === right.moralisOhlcvEnabled &&
    left.moralisDailyCuBudget === right.moralisDailyCuBudget &&
    left.maxSyncMoralisPages === right.maxSyncMoralisPages &&
    left.maxSyncGapCandles === right.maxSyncGapCandles &&
    left.externalApiKeyRequestRateLimit === right.externalApiKeyRequestRateLimit &&
    left.externalApiKeyCacheMissRateLimit === right.externalApiKeyCacheMissRateLimit &&
    left.externalApiKeyDailyCuBudget === right.externalApiKeyDailyCuBudget
  );
}
