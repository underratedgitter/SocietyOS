import { AppEnv, loadEnv } from './env';

export type { AppEnv };
export { resetEnvCacheForTests } from './env';

/** Lazily validated configuration. Never cache secrets in callers. */
export function getEnv(): AppEnv {
  return loadEnv();
}
