ALTER TABLE ohlcv_candles
ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'moralis';

ALTER TABLE ohlcv_backfill_jobs
ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'moralis';

ALTER TABLE market_history_state
ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'moralis';

ALTER TABLE ohlcv_candles
DROP CONSTRAINT IF EXISTS ohlcv_candles_pkey;

ALTER TABLE ohlcv_candles
ADD CONSTRAINT ohlcv_candles_pkey
PRIMARY KEY (provider, chain, pair_address, timeframe, currency, timestamp);

DROP INDEX IF EXISTS ohlcv_candles_lookup_idx;

CREATE INDEX IF NOT EXISTS ohlcv_candles_lookup_idx
ON ohlcv_candles (provider, chain, pair_address, timeframe, currency, timestamp DESC);

ALTER TABLE market_history_state
DROP CONSTRAINT IF EXISTS market_history_state_pkey;

ALTER TABLE market_history_state
ADD CONSTRAINT market_history_state_pkey
PRIMARY KEY (provider, chain, pair_address, timeframe, currency);

DROP INDEX IF EXISTS market_history_state_status_idx;

CREATE INDEX IF NOT EXISTS market_history_state_status_idx
ON market_history_state (provider, full_history_status, updated_at DESC);
