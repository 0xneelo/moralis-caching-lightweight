import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { config } from './config.js';

const logDirectory = path.dirname(config.LOG_FILE);
fs.mkdirSync(logDirectory, { recursive: true });

const fileStream = pino.destination({
  dest: config.LOG_FILE,
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
