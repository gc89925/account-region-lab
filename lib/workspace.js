import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDataDir } from './runtime.js';

export const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export function workspaceId(dataDir) {
  const path = resolve(dataDir);
  return createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex').slice(0,24);
}
export function launchSettings(env = process.env, configFile = resolve(PROJECT_ROOT,'launcher.local.json')) {
  const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile,'utf8')) : {};
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('launcher.local.json must be an object.');
  const port = Number(env.PORT || config.port || 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be 1024–65535.');
  const candidate = env.REGION_LAB_DATA_DIR || config.dataDir || defaultDataDir();
  if (typeof candidate !== 'string' || !candidate) throw new Error('Data directory is invalid.');
  return {port, dataDir:resolve(PROJECT_ROOT,candidate)};
}
