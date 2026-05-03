import fs from 'node:fs/promises';
import path from 'node:path';
import { appendInteractionTraceEvent } from './interactionLog.js';
import { moralisLogger } from './logger.js';
import type { OhlcvCurrency } from './types.js';

const MISSING_MORALIS_1D_DIR = path.join(process.cwd(), 'logs', 'missingCandlesMoralis');

export async function logMissingMoralisDailyCandles(params: {
  chain: string;
  pairAddress: string;
  currency: OhlcvCurrency;
  fromDate: Date;
  toDate: Date;
  pages: number;
  estimatedCu: number;
  truncated: boolean;
  interactionId?: string | undefined;
}) {
  const timestamp = new Date().toISOString();
  const payload = {
    timestamp,
    provider: 'moralis',
    timeframe: '1d' as const,
    chain: params.chain,
    pairAddress: params.pairAddress,
    currency: params.currency,
    from: params.fromDate.toISOString(),
    to: params.toDate.toISOString(),
    pages: params.pages,
    estimatedCu: params.estimatedCu,
    truncated: params.truncated,
    reason: 'no_1d_candles_returned',
  };

  await fs.mkdir(MISSING_MORALIS_1D_DIR, { recursive: true });
  const fileName = `${sanitizeFilePart(params.chain)}_${sanitizeFilePart(params.pairAddress)}.jsonl`;
  const filePath = path.join(MISSING_MORALIS_1D_DIR, fileName);
  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');

  moralisLogger.warn(
    {
      ...payload,
      event: 'MORALIS_1D_EMPTY_RANGE_LOGGED',
      logFile: filePath,
    },
    'MORALIS_1D_EMPTY_RANGE_LOGGED'
  );

  await appendInteractionTraceEvent(params.interactionId, 'moralis_missing_1d_logged', {
    chain: params.chain,
    pairAddress: params.pairAddress,
    currency: params.currency,
    from: params.fromDate.toISOString(),
    to: params.toDate.toISOString(),
    pages: params.pages,
    estimatedCu: params.estimatedCu,
    truncated: params.truncated,
    logFile: filePath,
  });
}

function sanitizeFilePart(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
}
