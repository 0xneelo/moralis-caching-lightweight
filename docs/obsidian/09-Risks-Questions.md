---
tags: [repo-map, risk, questions]
---

# Risks and Questions

Related: [[01-Architecture]], [[05-Backend-Map]], [[08-Operations-Testing]]

## P0 / security-sensitive

- `cloudflared-credentials.json` exists in the repo tree. Confirm it is not committed publicly and rotate if exposed.
- `.env`, `.local-external-api-key`, logs, and usage files exist under `moralisCacheSystem`. Confirm `.gitignore` covers secrets and generated runtime files.
- Admin routes rely on a shared bearer key. Production should put real auth/HTTPS/access controls in front of them.

## P1 / correctness

- `chartService.ts` throws plain `Error` from `assertChartRangeAllowed`; `server.ts` turns unknown errors into 500. Consider mapping range errors to `badRequest`.
- Full-history floor is hardcoded to `2024-01-01`. Confirm this matches product requirements for all chains/pairs.
- Daily bootstrap blocks non-daily Moralis fetches until `1d` history completes. Validate this UX is desired for new pairs.
- Synthetic `filled` candles are generated but hidden by the chart. Confirm response consumers understand these candles.

## P2 / operability

- Response cache only stores complete responses. Partial/warming states may cause repeated DB lookups.
- BullMQ and Redis are mandatory outside `localIndex.ts`; deployment must run API and worker separately.
- Static GitHub Pages frontend needs backend deployment/proxy strategy.

## P3 / maintainability

- Adaptive timeframe logic is duplicated in backend `timeframes.ts` and frontend `api.ts`; consider shared package or generated constants.
- `localIndex.ts` likely duplicates backend behavior; keep it tested or simplify to avoid divergence.
- Generated `dist/` and `client/dist/` should not be source of truth except for deployment debugging.

## Open questions

- Is TimescaleDB hypertable conversion expected but missing from migrations?
- What is the intended production deployment target for the backend?
- Should Moralis-compatible routes support every Moralis OHLC parameter or only current subset?
- What alerting should be attached to CU budget and provider errors?
