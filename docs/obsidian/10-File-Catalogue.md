---
tags: [repo-map, file-catalogue]
---

# File Catalogue

Related: [[00-Repo-Index]], [[05-Backend-Map]], [[06-Frontend-Map]]

## Root

- `README.md` — high-level project overview and launch instructions.
- `package.json` — workspace-level scripts delegating into `moralisCacheSystem`.
- `start.bat`, `start.ps1`, `start.sh` — dev launchers.
- `stop-dev.*` — stop helpers.
- `.github/workflows/pages.yml` — GitHub Pages frontend deployment.

## Backend source

- `src/index.ts` — real API entrypoint.
- `src/localIndex.ts` — local in-memory API.
- `src/worker.ts` — backfill worker entrypoint.
- `src/server.ts` — Fastify server assembly.
- `src/services/chartService.ts` — central OHLCV cache/provider orchestration.
- `src/moralis.ts` — Moralis provider integration.
- `src/cache.ts` — Redis chart response cache.
- `src/gaps.ts` — missing candle range detection.
- `src/candleQuality.ts` — OHLC normalization and suspicious daily candle detection.
- `src/timeframes.ts` — timeframe constants/adaptation/range guards.
- `src/rateLimit.ts` — request/provider/API-key limits and budgets.
- `src/locks.ts` — Redis lock helper.
- `src/config.ts` — environment schema.
- `src/db.ts` — Postgres pool/query/transaction.
- `src/redis.ts` — Redis clients and connection checks.
- `src/logger.ts` — Pino loggers.
- `src/interactionLog.ts` — interaction trace persistence.
- `src/missingCandlesMoralis.ts` — missing-daily-candle log support.
- `src/pairAddress.ts` — pair normalization helpers.
- `src/types.ts` — shared backend type definitions.

## Routes

- `routes/chartRoutes.ts` — native chart API.
- `routes/moralisCompatRoutes.ts` — Moralis-compatible external API.
- `routes/adminRoutes.ts` — backfill, Moralis enable/disable, external API keys.
- `routes/healthRoutes.ts` — health endpoint.
- `routes/usageRoutes.ts` — Moralis usage endpoint.
- `routes/interactionRoutes.ts` — debug interaction logging.

## Auth/jobs/repositories/scripts

- `auth/externalApiKeyAuth.ts` — `X-API-Key` verification.
- `jobs/queue.ts` — BullMQ queue singleton.
- `jobs/enqueue.ts` — queue + DB job creation.
- `jobs/backfillWorker.ts` — queued backfill execution.
- `jobs/scheduler.ts` — active pair refresh scheduling.
- `repositories/*.ts` — database access layer.
- `scripts/migrate.ts` — SQL migration runner.
- `scripts/ensureLocalExternalApiKey.ts` — local API key helper.
- `scripts/schedule.ts` — scheduler CLI.

## Frontend

- `client/src/App.tsx` — main terminal UI and state orchestration.
- `client/src/ChartPanel.tsx` — chart renderer.
- `client/src/api.ts` — frontend API/types/range utilities.
- `client/src/chains.ts` — supported chain metadata.
- `client/src/main.tsx` — app mount.
- `client/src/styles.css` — UI styling.
- `client/vite.config.ts` — frontend build config.

## Database migrations

- `001_init.sql` — candles, pairs, jobs, provider usage.
- `002_external_api_keys.sql` — external API key table.
- `003_provider_usage_external_keys.sql` — provider usage to API key relation.
- `004_market_history_state.sql` — full-history warmup state.

## Specs and existing docs

- `specs/28_04_2026/*` — original Moralis OHLC cache spec sections.
- `specs/29_04_2026/caching_protection.md` — caching/protection spec.
- `specs/30.04.2026/adaptiveCandles.md` — adaptive candles spec.
- `docs/vibe_chart_audit01.md` — existing audit.
- `docs/cachingSystem_docs01` — existing caching system notes.
