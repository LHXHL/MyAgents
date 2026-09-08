import type {
  RuntimePermissionDiagnostics,
  RuntimePermissionRule,
  RuntimePermissionRuleMutationResult,
  RuntimePermissionRulesSnapshot,
} from '../../../shared/types/runtime';
import type { DshRpcObject } from './protocol-types';

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_TARGET_LENGTH = 8_192;
const MAX_RULES = 512;

function object(value: unknown, description: string): DshRpcObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value as DshRpcObject;
}

function identifier(value: unknown, description: string): string {
  const hasControlCharacter = typeof value === 'string'
    && [...value].some(character => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    });
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_IDENTIFIER_LENGTH
    || hasControlCharacter
  ) {
    throw new Error(`${description} is invalid`);
  }
  return value;
}

function target(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TARGET_LENGTH) {
    throw new Error('DSH permission rule target is invalid');
  }
  return value;
}

function nonNegativeInteger(value: unknown, description: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${description} is invalid`);
  }
  return value as number;
}

export function parseDshPermissionRule(value: unknown): RuntimePermissionRule {
  const rule = object(value, 'DSH permission rule');
  if (rule.origin !== 'root') throw new Error('DSH permission rule origin is invalid');
  const createdAt = nonNegativeInteger(rule.createdAt, 'DSH permission rule createdAt');
  const expiresAt = rule.expiresAt === null ? null : nonNegativeInteger(rule.expiresAt, 'DSH permission rule expiresAt');
  if (expiresAt !== null && expiresAt < createdAt) throw new Error('DSH permission rule expiry is invalid');
  return Object.freeze({
    ruleId: identifier(rule.ruleId, 'DSH permission rule id'),
    revision: identifier(rule.revision, 'DSH permission rule revision'),
    tool: identifier(rule.tool, 'DSH permission rule tool'),
    permissionClass: identifier(rule.permissionClass, 'DSH permission rule class'),
    target: target(rule.target),
    origin: 'root',
    createdAt,
    expiresAt,
  });
}

export function parseDshPermissionRulesSnapshot(value: unknown): RuntimePermissionRulesSnapshot {
  const snapshot = object(value, 'DSH permission policy snapshot');
  if (!Array.isArray(snapshot.autoAllowTools) || !Array.isArray(snapshot.rules)) {
    throw new Error('DSH permission policy collections are invalid');
  }
  if (snapshot.autoAllowTools.length > MAX_RULES || snapshot.rules.length > MAX_RULES) {
    throw new Error('DSH permission policy exceeds protocol bounds');
  }
  const autoAllowTools = snapshot.autoAllowTools.map(entry => (
    identifier(entry, 'DSH auto-allow tool')
  ));
  if (new Set(autoAllowTools).size !== autoAllowTools.length) {
    throw new Error('DSH auto-allow tool catalog contains duplicates');
  }
  const rules = snapshot.rules.map(parseDshPermissionRule);
  if (new Set(rules.map(rule => rule.ruleId)).size !== rules.length) {
    throw new Error('DSH permission policy contains duplicate rule ids');
  }
  return Object.freeze({
    permissionMode: identifier(snapshot.permissionMode, 'DSH permission mode'),
    autoAllowTools: Object.freeze(autoAllowTools),
    revision: identifier(snapshot.revision, 'DSH permission policy revision'),
    rules: Object.freeze(rules),
  });
}

export function parseDshPermissionRuleMutation(
  value: unknown,
): RuntimePermissionRuleMutationResult {
  const result = object(value, 'DSH permission rule mutation');
  const revision = identifier(result.revision, 'DSH permission mutation revision');
  if (result.state === 'already_absent') {
    return Object.freeze({ state: result.state, revision });
  }
  if (result.state === 'already_effective') {
    return Object.freeze({
      state: result.state,
      revision,
      rule: parseDshPermissionRule(result.rule),
    });
  }
  if (result.state === 'applied') {
    return Object.freeze({
      state: result.state,
      revision,
      ...(result.rule === undefined ? {} : { rule: parseDshPermissionRule(result.rule) }),
    });
  }
  throw new Error('DSH permission mutation state is invalid');
}

export function validateDshPermissionIdentifier(value: string, description: string): string {
  return identifier(value, description);
}

export function validateDshPermissionTarget(value: string): string {
  return target(value);
}

export function projectDshPermissionDiagnostics(
  desiredProductMode: string,
  desiredRuntimeMode: string,
  snapshot: RuntimePermissionRulesSnapshot,
): RuntimePermissionDiagnostics {
  return Object.freeze({
    desiredProductMode,
    desiredRuntimeMode,
    effectiveRuntimeMode: snapshot.permissionMode,
    policyRevision: snapshot.revision,
    ruleCount: snapshot.rules.length,
    state: snapshot.permissionMode === desiredRuntimeMode ? 'applied' : 'drift',
  });
}
