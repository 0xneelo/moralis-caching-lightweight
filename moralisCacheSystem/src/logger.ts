import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { config } from './config.js';

const logDirectory = path.dirname(config.LOG_FILE);
fs.mkdirSync(logDirectory, { recursive: true });
const moralisLogDirectory = path.dirname(config.MORALIS_LOG_FILE);
fs.mkdirSync(moralisLogDirectory, { recursive: true });
const interactionLogDirectory = path.dirname(config.INTERACTION_LOG_FILE);
fs.mkdirSync(interactionLogDirectory, { recursive: true });
fs.mkdirSync(config.INTERACTION_LOG_DIR, { recursive: true });

const fileStream = pino.destination({
  dest: config.LOG_FILE,
  sync: false,
});

const moralisFileStream = pino.destination({
  dest: config.MORALIS_LOG_FILE,
  sync: false,
});

const interactionFileStream = pino.destination({
  dest: config.INTERACTION_LOG_FILE,
  sync: false,
});

export const logger = pino(
  {
    level: config.LOG_LEVEL,
  },
  pino.multistream([
    { stream: process.stdout },
    { stream: fileStream },
  ])
);

export const moralisLogger = pino(
  {
    level: config.LOG_LEVEL,
  },
  pino.multistream([
    { stream: process.stdout },
    { stream: moralisFileStream },
  ])
);

export const interactionLogger = pino(
  {
    level: config.LOG_LEVEL,
  },
  pino.multistream([{ stream: interactionFileStream }])
);
