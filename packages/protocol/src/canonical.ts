// Canonical JSON — the exact bytes every signature covers.
// Keys sorted by UTF-16 code unit order, no whitespace, no undefined, integers only for numbers that are signed.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function canonical(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return String(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonical: non-finite number');
      if (!Number.isSafeInteger(value)) throw new Error('canonical: only safe integers can be signed');
      return String(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => canonical(v)).join(',')}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => compareKeys(a, b));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
    }
    default:
      throw new Error(`canonical: cannot encode ${typeof value}`);
  }
}

function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
