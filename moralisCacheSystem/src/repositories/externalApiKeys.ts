import crypto from 'node:crypto';
import { query } from '../db.js';

export type ExternalApiKeyRecord = {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  active: boolean;
  requestCount: number;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

type ExternalApiKeyRow = {
  id: string;
  name: string;
  key_prefix: string;
  scopes: unknown;
  active: boolean;
  request_count: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
};

const DEFAULT_SCOPES = ['ohlcv:read'];

export const externalApiKeyRepository = {
  async create(params: { name: string; scopes?: string[] }) {
    const apiKey = generateExternalApiKey();
    const scopes = params.scopes && params.scopes.length > 0 ? params.scopes : DEFAULT_SCOPES;
    const result = await query<ExternalApiKeyRow>(
      `
      INSERT INTO external_api_keys (
        id,
        name,
        key_prefix,
        key_hash,
        scopes
      ) VALUES ($1, $2, $3, $4, $5::jsonb)
      RETURNING id, name, key_prefix, scopes, active, request_count::text, created_at, last_used_at, revoked_at
      `,
      [
        crypto.randomUUID(),
        params.name,
        getKeyPrefix(apiKey),
        hashApiKey(apiKey),
        JSON.stringify(scopes),
      ]
    );

    const row = result.rows[0];

    if (!row) {
      throw new Error('Failed to create external API key');
    }

    return {
      apiKey,
      record: mapExternalApiKey(row),
    };
  },

  async findActiveByApiKey(apiKey: string) {
    const result = await query<ExternalApiKeyRow>(
      `
      SELECT id, name, key_prefix, scopes, active, request_count::text, created_at, last_used_at, revoked_at
      FROM external_api_keys
      WHERE key_hash = $1
        AND active = TRUE
        AND revoked_at IS NULL
      LIMIT 1
      `,
      [hashApiKey(apiKey)]
    );

    const row = result.rows[0];
    return row ? mapExternalApiKey(row) : null;
  },

  async markUsed(id: string) {
    await query(
      `
      UPDATE external_api_keys
      SET request_count = request_count + 1,
          last_used_at = now()
      WHERE id = $1
      `,
      [id]
    );
  },

  async list() {
    const result = await query<ExternalApiKeyRow>(
      `
      SELECT id, name, key_prefix, scopes, active, request_count::text, created_at, last_used_at, revoked_at
      FROM external_api_keys
      ORDER BY created_at DESC
      `
    );

    return result.rows.map(mapExternalApiKey);
  },

  async revoke(id: string) {
    const result = await query<ExternalApiKeyRow>(
      `
      UPDATE external_api_keys
      SET active = FALSE,
          revoked_at = COALESCE(revoked_at, now())
      WHERE id = $1
      RETURNING id, name, key_prefix, scopes, active, request_count::text, created_at, last_used_at, revoked_at
      `,
      [id]
    );

    const row = result.rows[0];
    return row ? mapExternalApiKey(row) : null;
  },
};

function generateExternalApiKey() {
  return `mcs_live_${crypto.randomBytes(32).toString('base64url')}`;
}

function getKeyPrefix(apiKey: string) {
  return apiKey.slice(0, 16);
}

function hashApiKey(apiKey: string) {
  return crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

function mapExternalApiKey(row: ExternalApiKeyRow): ExternalApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    scopes: normalizeScopes(row.scopes),
    active: row.active,
    requestCount: Number(row.request_count),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

function normalizeScopes(scopes: unknown) {
  if (Array.isArray(scopes)) {
    return scopes.filter((scope): scope is string => typeof scope === 'string');
  }

  return DEFAULT_SCOPES;
}

