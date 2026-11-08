import { CloudApi } from './cloud';
import { Logger, maskId } from './log';
import { BiometricEvent } from './types';

export interface Source {
  readonly name: string;
  readonly pollIntervalSec: number;
  /** One poll cycle. Throws on failure so the runner can back off. */
  tick(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export interface SubmitCounts {
  recorded: number;
  duplicate: number;
  rejected: number;
}

/**
 * Posts one batch and resolves only when every outcome is RECORDED, DUPLICATE or REJECTED.
 * Anything else (HTTP error, wrong outcome count, unknown status) throws, so callers never
 * advance their cursor past events the cloud did not take a decision on.
 */
export async function submitBatch(cloud: CloudApi, events: BiometricEvent[], log: Logger): Promise<SubmitCounts> {
  const counts: SubmitCounts = { recorded: 0, duplicate: 0, rejected: 0 };
  if (events.length === 0) return counts;
  const outcomes = await cloud.postEvents(events);
  outcomes.forEach((outcome, i) => {
    if (outcome.status === 'RECORDED') counts.recorded++;
    else if (outcome.status === 'DUPLICATE') counts.duplicate++;
    else {
      counts.rejected++;
      // REJECTED events are final: logged for the installer, never retried.
      log.warn('event rejected by cloud', {
        deviceUserId: maskId(events[i]?.deviceUserId ?? ''),
        reason: outcome.reason.slice(0, 200),
      });
    }
  });
  return counts;
}
