/** Express 5 route params may be string | string[]; coerce to a single string. */
export function paramStr(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v[0] : (v ?? '');
}
