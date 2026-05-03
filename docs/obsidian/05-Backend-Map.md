---
tags: [repo-map, backend, modules]
---

# Backend Map

Related: [[01-Architecture]], [[02-Runtime-Flow]], [[03-API-Surface]], [[04-Data-Model]]

## Entrypoints

- `src/index.ts` — real API entrypoint; loads config, ensures Redis, builds server, handles shutdown.
- `src/localIndex.ts` — local in-memory API for no-Docker UI testing.
- `src/worker.ts` — starts BullMQ backfill worker and handles graceful shutdown.

## Server composition

`src/server.ts` creates Fastify with CORS, global rate-limit, route registration, and centralized error handling.

Registered route modules: `healthRoutes`, `moralisCompatRoutes`, `chartRoutes`, `usageRoutes`, `interactionRoutes`, `adminRoutes`.

## Core service

`src/services/chartService.ts` is the main business logic:

1. Normalize pair address.
2. Validate candle range.
3. Enforce chart request rate limit.
4. Touch pair usage.
5. Read history state, potentially enqueue full-history/daily bootstrap.
6. Read Redis response cache.
7. Load stored candles from Postgres.
8. Detect missing/suspicious ranges.
9. Enforce provider/API-key miss limits and CU budget.
10. Fetch small gaps from Moralis under Redis lock.
11. Queue large gaps.
12. Upsert candles, bounds, usage.
13. Fill chart gaps, compute history state, cache final response if complete.

## Repositories

- `repositories/candles.ts` — candle query/upsert/bounds.
- `repositories/pairs.ts` — pair tracking and active pair lookup.
- `repositories/backfillJobs.ts` — persistent job status.
- `repositories/providerUsage.ts` — CU accounting and usage totals.
- `repositories/externalApiKeys.ts` — key creation, lookup, list, revoke.
- `repositories/marketHistoryState.ts` — history warmup/progress/completion.

## Helpers

- `config.ts`, `db.ts`, `redis.ts`, `logger.ts`, `httpErrors.ts`, `interactionLog.ts`.
- `cache.ts`, `gaps.ts`, `candleQuality.ts`, `locks.ts`, `rateLimit.ts`, `timeframes.ts`, `pairAddress.ts`.
- `moralis.ts` owns provider calls, CU checks, feature flag checks, pagination/truncation, and usage tracing.

## Jobs

- `jobs/queue.ts` — BullMQ queue singleton.
- `jobs/enqueue.ts` — creates DB job record and BullMQ job.
- `jobs/backfillWorker.ts` — fetches queued ranges and writes candles/history/usage.
- `jobs/scheduler.ts` — queues refreshes for active pairs.
