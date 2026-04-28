# Moralis Caching Lightweight

Cache-first OHLC charting prototype for reducing Moralis overage.

## Live Frontend

GitHub Pages deploys the test trading terminal from `moralisCacheSystem/client`:

```text
https://0xneelo.github.io/moralis-caching-lightweight/
```

The Pages build is a static frontend. For live cached OHLC calls, run the API locally or deploy the backend separately.

## Local Start

Windows:

```powershell
.\start.bat
```

PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

Bash:

```bash
./start.sh
```

If Docker is available, the launcher starts Redis/Postgres, runs migrations, and starts the API, worker, and frontend. If Docker is not available, it falls back to local in-memory mode.

## Full Spec

Start here:

```text
specs/MORALIS_OHLC_CACHE_SPEC.md
```
