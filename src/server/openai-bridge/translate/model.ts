import { stripModelSuffix } from '../../../shared/contextUsage';
import type { BridgeConfig } from '../types/bridge';

/** Resolve once before capability decisions, affinity hashing and translation. */
export function resolveBridgeModel(model: string, override?: string, mapping?: BridgeConfig['modelMapping']): string {
  const target = override || (typeof mapping === 'function' ? mapping(model) : mapping?.[model]) || model;
  return stripModelSuffix(target) ?? target;
}
