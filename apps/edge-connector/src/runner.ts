import { backoffDelayMs, sleep } from './backoff';
import { Source } from './ingest';
import { Logger, errorMessage } from './log';

export interface RunnerOptions {
  secrets?: readonly string[];
  sleepFn?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

/**
 * Runs each source in its own loop. Aborting the signal lets the in-flight tick finish (it is
 * never interrupted mid-batch), cancels pending sleeps, then closes every source.
 */
export async function runSources(sources: Source[], signal: AbortSignal, log: Logger, opts: RunnerOptions = {}): Promise<void> {
  const sleepFn = opts.sleepFn ?? sleep;
  const loops = sources.map(async (source) => {
    let failures = 0;
    while (!signal.aborted) {
      let delay: number;
      try {
        await source.tick(signal);
        failures = 0;
        delay = source.pollIntervalSec * 1000;
      } catch (error) {
        failures++;
        delay = backoffDelayMs(failures, 1000, 60_000, opts.random);
        log.error('poll failed, backing off', {
          source: source.name,
          failures,
          retryInMs: delay,
          error: errorMessage(error, opts.secrets),
        });
      }
      await sleepFn(delay, signal);
    }
  });
  await Promise.all(loops);
  await Promise.all(
    sources.map((s) =>
      s.close().catch((error) => log.error('close failed', { source: s.name, error: errorMessage(error, opts.secrets) })),
    ),
  );
}
