import { describe, expect, it } from 'vitest';

import {
  parseDshPermissionRuleMutation,
  parseDshPermissionRulesSnapshot,
  projectDshPermissionDiagnostics,
  validateDshPermissionIdentifier,
  validateDshPermissionTarget,
} from './permission-rules';

const rule = {
  ruleId: 'rule-1',
  revision: 'permission-revision-2',
  tool: 'Bash',
  permissionClass: 'process.execute',
  target: 'npm test',
  origin: 'root',
  createdAt: 1_000,
  expiresAt: null,
};

describe('DSH permission rule wire parsing', () => {
  it('accepts and freezes an authoritative policy snapshot', () => {
    const snapshot = parseDshPermissionRulesSnapshot({
      permissionMode: 'approval-required',
      autoAllowTools: ['Read'],
      revision: 'permission-revision-2',
      rules: [rule],
    });

    expect(snapshot).toEqual({
      permissionMode: 'approval-required',
      autoAllowTools: ['Read'],
      revision: 'permission-revision-2',
      rules: [rule],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.rules[0])).toBe(true);
  });

  it('rejects malformed, duplicate, or non-root rules', () => {
    expect(() => parseDshPermissionRulesSnapshot({
      permissionMode: 'approval-required',
      autoAllowTools: [],
      revision: 'permission-revision-2',
      rules: [{ ...rule, origin: 'child' }],
    })).toThrow('origin');
    expect(() => parseDshPermissionRulesSnapshot({
      permissionMode: 'approval-required',
      autoAllowTools: [],
      revision: 'permission-revision-2',
      rules: [rule, rule],
    })).toThrow('duplicate rule ids');
    expect(() => parseDshPermissionRulesSnapshot({
      permissionMode: 'approval-required',
      autoAllowTools: [],
      revision: 'permission-revision-2',
      rules: [{ ...rule, expiresAt: 999 }],
    })).toThrow('expiresAt');
  });

  it('accepts only an explicit Session lifetime', () => {
    const snapshot = { permissionMode: 'approval-required', autoAllowTools: [], revision: 'permission-revision-2', rules: [rule] };
    expect(parseDshPermissionRulesSnapshot(snapshot).rules[0]?.expiresAt).toBeNull();
    for (const expiresAt of [undefined, 'forever', -1, Number.NaN, 2_000]) {
      expect(() => parseDshPermissionRulesSnapshot({ ...snapshot, rules: [{ ...rule, expiresAt }] })).toThrow('expiresAt');
    }
  });

  it('rejects old DSH permission modes', () => {
    expect(() => parseDshPermissionRulesSnapshot({
      permissionMode: 'acceptEdits', autoAllowTools: [], revision: 'permission-revision-2', rules: [],
    })).toThrow('permission mode');
  });

  it('parses all retry-safe mutation states', () => {
    expect(parseDshPermissionRuleMutation({
      state: 'applied',
      revision: 'permission-revision-2',
      rule,
    })).toEqual({ state: 'applied', revision: 'permission-revision-2', rule });
    expect(parseDshPermissionRuleMutation({
      state: 'already_effective',
      revision: 'permission-revision-2',
      rule,
    })).toEqual({ state: 'already_effective', revision: 'permission-revision-2', rule });
    expect(parseDshPermissionRuleMutation({
      state: 'already_absent',
      revision: 'permission-revision-3',
    })).toEqual({ state: 'already_absent', revision: 'permission-revision-3' });
    expect(() => parseDshPermissionRuleMutation({
      state: 'accepted',
      revision: 'permission-revision-2',
    })).toThrow('state');
  });

  it('enforces protocol identifier and target bounds before sending mutations', () => {
    expect(validateDshPermissionIdentifier('rule-1', 'rule')).toBe('rule-1');
    expect(validateDshPermissionTarget('npm test')).toBe('npm test');
    expect(() => validateDshPermissionIdentifier('bad\nrule', 'rule')).toThrow('invalid');
    expect(() => validateDshPermissionTarget('')).toThrow('invalid');
  });

  it('reports desired/effective reconciliation without projecting exact targets', () => {
    const snapshot = parseDshPermissionRulesSnapshot({
      permissionMode: 'full-autonomous',
      autoAllowTools: [],
      revision: 'permission-revision-2',
      rules: [rule],
    });
    expect(projectDshPermissionDiagnostics('workspace-autonomous', snapshot)).toEqual({
      desiredProductMode: 'workspace-autonomous',
      desiredRuntimeMode: 'workspace-autonomous',
      effectiveRuntimeMode: 'full-autonomous',
      policyRevision: 'permission-revision-2',
      ruleCount: 1,
      state: 'drift',
    });
    expect(JSON.stringify(projectDshPermissionDiagnostics('workspace-autonomous', snapshot)))
      .not.toContain('npm test');
  });
});
