CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ohlcv_candles (
  chain TEXT NOT NULL,
  pair_address TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  timestamp TIMESTAMPTZ NOT NULL,
  open NUMERIC NOT NULL,
  high NUMERIC NOT NULL,
  low NUMERIC NOT NULL,
  close NUMERIC NOT NULL,
  volume NUMERIC,
  trades INTEGER,
  source TEXT NOT NULL DEFAULT 'moralis',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, pair_address, timeframe, currency, timestamp)
);

CREATE INDEX IF NOT EXISTS ohlcv_candles_lookup_idx
ON ohlcv_candles (chain, pair_address, timeframe, currency, timestamp DESC);

CREATE TABLE IF NOT EXISTS chart_pairs (
  chain TEXT NOT NULL,
  pair_address TEXT NOT NULL,
  base_token_address TEXT,
  quote_token_address TEXT,
  symbol TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_hot BOOLEAN NOT NULL DEFAULT FALSE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_requested_at TIMESTAMPTZ,
  last_refreshed_at TIMESTAMPTZ,
  request_count_24h INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chain, pair_address)
);

CREATE INDEX IF NOT EXISTS chart_pairs_hot_idx
ON chart_pairs (is_hot, is_active, last_requested_at DESC);

CREATE TABLE IF NOT EXISTS ohlcv_backfill_jobs (
  id TEXT PRIMARY KEY,
  queue_job_id TEXT,
  chain TEXT NOT NULL,
  pair_address TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  from_ts TIMESTAMPTZ NOT NULL,
  to_ts TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  priority TEXT NOT NULL DEFAULT 'normal',
  reason TEXT NOT NULL DEFAULT 'admin',
  error_message TEXT,
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  candles_inserted INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ohlcv_backfill_jobs_status_idx
ON ohlcv_backfill_jobs (status, priority, created_at);

CREATE TABLE IF NOT EXISTS provider_api_usage (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  chain TEXT,
  pair_address TEXT,
  timeframe TEXT,
  request_from TIMESTAMPTZ,
  request_to TIMESTAMPTZ,
  http_status INTEGER,
  estimated_cu INTEGER NOT NULL DEFAULT 0,
  pages INTEGER NOT NULL DEFAULT 1,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS provider_api_usage_created_idx
ON provider_api_usage (created_at DESC, provider, endpoint);

CREATE INDEX IF NOT EXISTS provider_api_usage_pair_idx
ON provider_api_usage (provider, chain, pair_address, timeframe, created_at DESC);
