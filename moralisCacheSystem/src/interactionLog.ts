import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const interactionLogFiles = new Map<string, string>();

export async function writeInteractionLogFile(payload: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  const event = typeof payload.event === 'string' ? payload.event : 'interaction';
  const interactionId =
    typeof payload.interactionId === 'string' && payload.interactionId
      ? sanitizeFilenamePart(payload.interactionId)
      : cryptoRandomSuffix();
  const fullPath = createInteractionLogPath({
    interactionId,
    event,
    timestamp,
  });
  interactionLogFiles.set(interactionId, fullPath);

  await appendJsonLine(fullPath, {
    type: 'ui_click',
    event,
    ...payload,
    interactionId,
    timestamp,
  });

  return { interactionId, logFile: fullPath };
}

export async function appendInteractionTraceEvent(
  interactionId: string | undefined,
  event: string,
  payload: Record<string, unknown>
) {
  if (!interactionId) {
    return;
  }

  await appendJsonLine(getInteractionLogPath(sanitizeFilenamePart(interactionId)), {
    type: event,
    interactionId,
    timestamp: new Date().toISOString(),
    ...payload,
  });
}

function getInteractionLogPath(interactionId: string) {
  return interactionLogFiles.get(interactionId) ?? path.join(config.INTERACTION_LOG_DIR, `${interactionId}.jsonl`);
}

function createInteractionLogPath(params: {
  interactionId: string;
  event: string;
  timestamp: string;
}) {
  return path.join(
    config.INTERACTION_LOG_DIR,
    `${params.timestamp.replace(/[:.]/g, '-')}_${sanitizeFilenamePart(params.event)}_${params.interactionId}.jsonl`
  );
}

async function appendJsonLine(filePath: string, payload: Record<string, unknown>) {
  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function sanitizeFilenamePart(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

function cryptoRandomSuffix() {
  return Math.random().toString(36).slice(2, 10);
}
