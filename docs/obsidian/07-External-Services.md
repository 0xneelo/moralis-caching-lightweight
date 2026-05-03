---
tags: [repo-map, external-services, moralis, redis, database]
---

# External Services

Related: [[01-Architecture]], [[04-Data-Model]], [[08-Operations-Testing]]

## Moralis

Used for OHLCV provider fetches when cache/DB cannot satisfy a requested range. Safeguards include `CHART_PROVIDER_ENABLED`, Redis feature flag, daily CU budget, max sync pages, max sync gap candles, usage logging, and external API-key budgets.

## Redis

Required for production-like backend mode: response cache, locks, rate limits, feature flags, and BullMQ queue. Configured via `REDIS_URL`.

## Postgres / TimescaleDB

Canonical candle and metadata store. Configured via `DATABASE_URL`. Migrations live under `moralisCacheSystem/migrations`.

## Dexscreener

Frontend-only metadata lookup for labels and token symbols. Failure is tolerated by falling back to shortened pair address plus chain label.

## GitHub Pages

`.github/workflows/pages.yml` deploys static frontend from `moralisCacheSystem/client`. The static frontend still needs a live backend for cached OHLC calls unless proxied/deployed separately.

## Cloudflare tunnel

Repo contains `start-cloudflare-tunnel.ps1`, `cloudflared-credentials.json`, and `tools/cloudflared.exe`. Treat credentials as sensitive.
