import * as path from 'path';
import { BioStar2Api, BioStar2Source } from './biostar2';
import { CloudClient } from './cloud';
import { AppConfig, SourceConfig, loadConfig } from './config';
import { createSqlClient } from './db';
import { createFetchClient, createNodeHttpClient } from './http';
import { Source } from './ingest';
import { createLogger, errorMessage } from './log';
import { runSources } from './runner';
import { SqlSource } from './sql-source';
import { FileStateStore } from './state';
import { ConfigError } from './types';

// Same loader semantics as device-simulator: real env vars win over .env values.
try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

const log = createLogger('edge-connector');

function secretsOf(config: AppConfig): string[] {
  const out: string[] = [];
  for (const s of config.sources) {
    out.push(s.deviceToken);
    if (s.type === 'sql') out.push(s.connectionString);
    else out.push(s.loginId, s.password);
  }
  return out;
}

function buildSource(cfg: SourceConfig, config: AppConfig): Source {
  const cloud = new CloudClient(createFetchClient(config.cloud.requestTimeoutMs), config.cloud.baseUrl, cfg.deviceToken);
  const state = new FileStateStore(path.join(config.stateDir, `${cfg.name}.state.json`));
  const sourceLog = createLogger(cfg.name);
  if (cfg.type === 'sql') return new SqlSource(cfg, createSqlClient(cfg), cloud, state, sourceLog);
  const api = new BioStar2Api(createNodeHttpClient(config.cloud.requestTimeoutMs, cfg.caFile), cfg);
  return new BioStar2Source(cfg, api, cloud, state, sourceLog);
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const sources = config.sources.map((s) => buildSource(s, config));
  const controller = new AbortController();
  const stop = (signal: string): void => {
    log.info('shutdown requested, finishing in-flight batch', { signal });
    controller.abort();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  log.info('started', { sources: sources.map((s) => s.name).join(',') });
  await runSources(sources, controller.signal, log, { secrets: secretsOf(config) });
  log.info('stopped');
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) process.stderr.write(`${error.message}\n`);
  else log.error('fatal', { error: errorMessage(error) });
  process.exit(1);
});
