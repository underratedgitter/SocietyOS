/**
 * Vendor-neutral biometric event contract.
 *
 * Commercial face/fingerprint terminals (ZKTeco/eSSL, Matrix COSEC, Hikvision, Dahua, Suprema,
 * Realtime, Mantra, ...) match on the device itself and report which *device user ID* was
 * recognised. Every vendor integration (push protocol parser, edge connector, middleware webhook)
 * converts its native payload into this shape, so the rest of SocietyOS never sees vendor formats
 * and never receives raw biometric templates.
 */

export const VERIFY_METHODS = ['FINGERPRINT', 'FACE', 'CARD', 'PIN', 'PALM', 'IRIS', 'UNKNOWN'] as const;
export type VerifyMethod = (typeof VERIFY_METHODS)[number];

export interface VendorBiometricEvent {
  /** User ID as stored on the terminal (ZKTeco PIN, Hikvision employeeNo, Matrix user ID). */
  deviceUserId: string;
  method: VerifyMethod;
  /** When the person was at the terminal (device clock), not when we received it. */
  occurredAt: Date;
  /** Whether the terminal itself matched the person. Unmatched scans are logged as denials. */
  matched: boolean;
  /** Stable vendor identifier for dedupe when the device provides one (log/serial number). */
  vendorEventId?: string;
}

/** IDs SocietyOS allocates are numeric: the only format every vendor accepts (ZKTeco PINs). */
export const ALLOCATED_USER_ID_PATTERN = /^[1-9][0-9]{0,8}$/;
/** IDs accepted from devices, which may predate SocietyOS (Hikvision/Matrix allow letters). */
export const DEVICE_USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** Max lag accepted between the terminal clock and now; older punches are offline backlog. */
export const MAX_EVENT_AGE_MS = 7 * 24 * 3600 * 1000;
/** Terminal clocks drift; a punch slightly in the future is still accepted. */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export function dedupeKeyFor(event: VendorBiometricEvent): string {
  return event.vendorEventId
    ? `id:${event.vendorEventId}`
    : `u:${event.deviceUserId}:${event.occurredAt.toISOString()}`;
}

export type IngestOutcome =
  | { status: 'DUPLICATE'; dedupeKey: string }
  | { status: 'REJECTED'; dedupeKey: string; reason: string }
  | {
      status: 'RECORDED';
      dedupeKey: string;
      accessEventId: string;
      decision: 'AUTHORIZED' | 'DENIED';
      reasonCode: string;
    };
