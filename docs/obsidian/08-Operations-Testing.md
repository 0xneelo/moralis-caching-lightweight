---
tags: [repo-map, ops, testing]
---

# Operations and Testing

Related: [[01-Architecture]], [[07-External-Services]], [[09-Risks-Questions]]

## Root scripts

`package.json` delegates to `moralisCacheSystem`: `dev`, `dev:local`, `dev:docker`, `stop`, `test`, and `test:e2e:full`.

## Service scripts

- `npm run dev` — API watch mode.
- `npm run dev:local` — local memory API + frontend.
- `npm run dev:all` — API + worker + frontend.
- `npm run dev:docker` — infra + migrations + all processes.
- `npm run dev:worker` — worker watch mode.
- `npm run build:all` — TypeScript backend + Vite frontend build.
- `npm run migrate` — run SQL migrations.
- `npm run schedule` — queue active pair refresh jobs.
- `npm run test:e2e:full` — typecheck, frontend typecheck, e2e tests, production build.

## Important env vars

`MORALIS_API_KEY`, `DATABASE_URL`, `REDIS_URL`, `PORT`, `ADMIN_API_KEY`, `MORALIS_DAILY_CU_BUDGET`, `MAX_SYNC_MORALIS_PAGES`, `MAX_SYNC_GAP_CANDLES`, `EXTERNAL_API_KEY_REQUEST_RATE_LIMIT`, `EXTERNAL_API_KEY_CACHE_MISS_RATE_LIMIT`, `EXTERNAL_API_KEY_DAILY_CU_BUDGET`, `DEFAULT_CURRENCY`.

## Logs

- `logs/app.log`
- `logs/moralis.log`
- `logs/interactions.log`
- `logs/interactions/` for detailed traces

## Tests

Visible tests: `timeframes.test.ts`, `gaps.test.ts`, `candleQuality.test.ts`, `e2e/chart.e2e.test.ts`, `e2e/migration.e2e.test.ts`.

Recommended loop:

```bash
npm --prefix moralisCacheSystem run typecheck
npm --prefix moralisCacheSystem run typecheck:frontend
npm --prefix moralisCacheSystem test
npm --prefix moralisCacheSystem run build:all
```
