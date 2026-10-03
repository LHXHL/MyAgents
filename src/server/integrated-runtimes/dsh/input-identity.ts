import { createHash } from 'node:crypto';

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('DSH input identity requires JSON data');
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}

/** Exact native operation input identity; opaque attachment leases are absent. */
export function fingerprintDshNativeInput(input: unknown): string {
  return createHash('sha256').update(canonical({ format: 'myagents-dsh-operation-input-v1', input })).digest('hex');
}
