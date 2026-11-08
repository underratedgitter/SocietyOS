export const VERIFY_METHODS = ['FINGERPRINT', 'FACE', 'CARD', 'PIN', 'PALM', 'IRIS', 'UNKNOWN'] as const;
export type VerifyMethod = (typeof VERIFY_METHODS)[number];

/** Mirrors VendorBiometricEventDto in apps/api (occurredAt is ISO 8601 with offset). */
export interface BiometricEvent {
  deviceUserId: string;
  method: VerifyMethod;
  occurredAt: string;
  matched: boolean;
  vendorEventId?: string;
}

export type Outcome =
  | { status: 'RECORDED'; dedupeKey: string }
  | { status: 'DUPLICATE'; dedupeKey: string }
  | { status: 'REJECTED'; dedupeKey: string; reason: string };

export type SyncCommandKind = 'UPSERT_USER' | 'DELETE_USER' | 'OPEN_DOOR';

export interface SyncCommand {
  id: string;
  kind: SyncCommandKind;
  payload: { deviceUserId?: string; name?: string };
}

export const DEVICE_USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const MAX_EVENTS_PER_CALL = 500;

export class ConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class ConfigError extends ConnectorError {}
export class CloudError extends ConnectorError {}
export class SourceError extends ConnectorError {}
