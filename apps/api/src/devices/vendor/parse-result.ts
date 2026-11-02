import { VendorBiometricEvent } from './vendor-event';

/** Result of a pure vendor payload parser; `ignored` counts non-verification or unusable records. */
export interface ParseResult {
  events: VendorBiometricEvent[];
  ignored: number;
}
