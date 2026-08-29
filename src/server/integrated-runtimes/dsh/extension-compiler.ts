import { createHash } from 'node:crypto';

import type { DshRpcObject } from './protocol-types';

export type DshExtensionSnapshot = Readonly<{
  formatVersion: 1;
  revision: string;
  digest: string;
  components: readonly DshRpcObject[];
  resources: readonly DshRpcObject[];
  skillSourcePolicy: Readonly<{
    revision: string;
    roots: readonly DshRpcObject[];
  }>;
}>;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return Object.freeze(value);
}

export function compileDshExtensionSnapshot(input?: {
  revision?: string;
  components?: readonly DshRpcObject[];
  resources?: readonly DshRpcObject[];
  skillRoots?: readonly DshRpcObject[];
}): DshExtensionSnapshot {
  const revision = input?.revision ?? 'myagents-dsh-extensions-v1:empty';
  const authority = {
    formatVersion: 1 as const,
    revision,
    components: structuredClone(input?.components ?? []),
    resources: structuredClone(input?.resources ?? []),
    skillSourcePolicy: {
      revision: `${revision}:skill-policy`,
      roots: structuredClone(input?.skillRoots ?? []),
    },
  };
  const digest = createHash('sha256').update(stableJson(authority)).digest('hex');
  return deepFreeze({ ...authority, digest });
}
