ALTER TABLE provider_api_usage
ADD COLUMN IF NOT EXISTS external_api_key_id TEXT REFERENCES external_api_keys(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS provider_api_usage_external_key_idx
ON provider_api_usage (external_api_key_id, created_at DESC);

