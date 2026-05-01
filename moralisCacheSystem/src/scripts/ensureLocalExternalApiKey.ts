import fs from 'node:fs/promises';
import path from 'node:path';
import { closeDb } from '../db.js';
import { externalApiKeyRepository } from '../repositories/externalApiKeys.js';

const keyFile = path.resolve(process.cwd(), '.local-external-api-key');

try {
  const existingKey = await readExistingKey();

  if (existingKey) {
    const existingRecord = await externalApiKeyRepository.findActiveByApiKey(existingKey);

    if (existingRecord) {
      printLocalKey(existingKey, 'Using existing local external API key');
      process.exit(0);
    }
  }

  const created = await externalApiKeyRepository.create({
    name: 'local launcher',
  });

  await fs.writeFile(keyFile, `${created.apiKey}\n`, { encoding: 'utf8', mode: 0o600 });
  printLocalKey(created.apiKey, 'Created local external API key');
} catch (error) {
  console.error('Failed to ensure local external API key.');
  console.error(error);
  process.exitCode = 1;
} finally {
  await closeDb();
}

async function readExistingKey() {
  try {
    const value = await fs.readFile(keyFile, 'utf8');
    return value.trim() || null;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

function printLocalKey(apiKey: string, message: string) {
  console.log('');
  console.log(message);
  console.log(`X-API-Key: ${apiKey}`);
  console.log('');
  console.log('Moralis-compatible local base URL:');
  console.log('http://localhost:3001');
  console.log('');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

