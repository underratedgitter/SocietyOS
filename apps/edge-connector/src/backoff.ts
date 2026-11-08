/** Exponential backoff with jitter. `random` is injectable for tests. */
export function backoffDelayMs(
  failures: number,
  baseMs = 1000,
  capMs = 60_000,
  random: () => number = Math.random,
): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, failures - 1));
  return Math.floor(exp / 2 + random() * (exp / 2));
}

/** A sleep that resolves early (and clears its timer) when the signal aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
