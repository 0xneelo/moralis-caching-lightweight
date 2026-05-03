---
tags: [repo-map, api, backend]
---

# API Surface

Related: [[02-Runtime-Flow]], [[05-Backend-Map]], [[04-Data-Model]]

## Public chart API

### `GET /api/charts/ohlcv`

Implemented in `moralisCacheSystem/src/routes/chartRoutes.ts`.

Query params: `chain`, `pairAddress`, `timeframe`, optional `requestedTimeframe`, optional `currency`, `from`, `to`, optional `visibleFrom`, `visibleTo`.

Headers accepted: optional `x-user-id` for rate-limit identity and `x-interaction-id` for trace correlation.

Response fields include `source`, `partial`, `historyComplete`, `historyWarming`, `historyProgressPct`, `marketStart`, and `candles[]`.

Response headers include requested/effective timeframe, source, history status, progress, and market start.

## Moralis-compatible routes

Implemented in `moralisCacheSystem/src/routes/moralisCompatRoutes.ts`.

- `GET /api/v2.2/pairs/:pairAddress/ohlcv` — EVM-style compatibility path. Requires `X-API-Key`.
- `GET /token/mainnet/pairs/:pairAddress/ohlcv` — Solana-style compatibility path. Requires `X-API-Key`.

Compatibility behavior:

- Authenticates via `externalApiKeyAuth.ts`.
- Enforces external API-key request rate limit.
- Adapts timeframe and clamps limit.
- Uses cursor pagination encoded as base64url JSON.
- Returns Moralis-style `{ cursor, result }` body.
- Emits headers such as `x-moralis-cu-used`, `x-cache-source`, `x-effective-timeframe`.

## Admin routes

Implemented in `moralisCacheSystem/src/routes/adminRoutes.ts`. All require `Authorization: Bearer <ADMIN_API_KEY>`.

- `POST /api/admin/charts/backfill` — queue one job per timeframe.
- `POST /api/admin/moralis/enabled` — write Redis feature flag `feature:moralis_ohlcv_enabled`.
- `POST /api/admin/api-keys` — create external API key.
- `GET /api/admin/api-keys` — list keys.
- `DELETE /api/admin/api-keys/:id` — revoke key.

## Health, usage, debug

- `GET /health` in `healthRoutes.ts`: checks DB/Redis health.
- `GET /api/usage/moralis` in `usageRoutes.ts`: returns provider CU/request usage.
- `POST /api/debug/interactions` in `interactionRoutes.ts`: writes UI interaction traces.

## Error handling

`server.ts` catches custom `HttpError` and returns `{ error }` with the declared status code. Unknown errors are logged and returned as `500 Internal server error`.
