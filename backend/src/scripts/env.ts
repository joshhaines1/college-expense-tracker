import path from 'node:path';
import dotenv from 'dotenv';
import { googleConfig, loadConfig, type Config, type GoogleConfig } from '../lib/config';

/** Loads the repo-root .env (works from src/ via tsx and from dist/ in Docker) and returns validated config. */
export function loadScriptConfig(): Config {
  dotenv.config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
  return loadConfig();
}

export function requireGoogle(cfg: Config): GoogleConfig {
  const g = googleConfig(cfg);
  if (!g.ok) {
    console.error(`Missing in .env: ${g.missing.join(', ')}`);
    process.exit(1);
  }
  return g.value;
}

export function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}
