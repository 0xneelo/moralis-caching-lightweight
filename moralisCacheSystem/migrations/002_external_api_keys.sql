CREATE TABLE IF NOT EXISTS external_api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes JSONB NOT NULL DEFAULT '["ohlcv:read"]'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  request_count BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS external_api_keys_active_idx
ON external_api_keys (active, created_at DESC);

