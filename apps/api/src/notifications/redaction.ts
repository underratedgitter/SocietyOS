/** Mock dispatchers keep at most this many records so the production fallback cannot grow unbounded. */
export const MOCK_STORE_LIMIT = 200;

/** Masks all but the last four digits so logs stay useful for support without exposing the number. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  return `***${digits.slice(-4)}`;
}

/** Drops the oldest records once the store exceeds MOCK_STORE_LIMIT. */
export function capMockStore<T>(store: T[]): void {
  if (store.length > MOCK_STORE_LIMIT) store.splice(0, store.length - MOCK_STORE_LIMIT);
}
