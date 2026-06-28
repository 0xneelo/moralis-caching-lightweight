CREATE TABLE IF NOT EXISTS market_history_state (
  provider TEXT NOT NULL DEFAULT 'moralis',
  chain TEXT NOT NULL,
  pair_address TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  history_floor_ts TIMESTAMPTZ NOT NULL,
  market_start_ts TIMESTAMPTZ,
  latest_synced_ts TIMESTAMPTZ,
  full_history_status TEXT NOT NULL DEFAULT 'unknown',
  full_history_job_id TEXT,
  full_history_requested_at TIMESTAMPTZ,
  full_history_completed_at TIMESTAMPTZ,
  full_history_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, chain, pair_address, timeframe, currency)
);

CREATE INDEX IF NOT EXISTS market_history_state_status_idx
ON market_history_state (full_history_status, updated_at DESC);
