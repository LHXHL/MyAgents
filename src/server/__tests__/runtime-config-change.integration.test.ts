// Tests for the cross-runtime-switch scrub helper and migration.
// Issue #194 follow-up — locks the contract documented in
// shared/types/runtime.ts::buildRuntimeChangePatch and
// migrations/scrub-stale-runtime-config.ts.

import { describe, it, expect } from 'vitest';
import { buildRuntimeChangePatch } from '../../shared/types/runtime';

describe('buildRuntimeChangePatch', () => {
  it('returns runtimeConfig: undefined when current is undefined', () => {
    const patch = buildRuntimeChangePatch(undefined, 'codex');
    expect(patch).toEqual({
      runtime: 'codex',
      runtimeConfig: undefined,
      runtimePreference: { family: 'external', id: 'codex' },
    });
  });

  it('scrubs source / model / permissionMode / reasoningEffort / additionalArgs', () => {
    const patch = buildRuntimeChangePatch(
      {
        source: 'managed-provider',
        model: 'claude-sonnet-4-5',
        permissionMode: 'bypassPermissions',
        reasoningEffort: 'xhigh',
        additionalArgs: ['--verbose'],
      },
      'codex',
    );
    expect(patch.runtime).toBe('codex');
    expect(patch.runtimePreference).toEqual({ family: 'external', id: 'codex' });
    expect(patch.runtimeConfig).toBeUndefined();  // all fields were per-runtime → empty → undefined
  });

  it('dual-writes Integrated Runtime preferences with their legacy projections', () => {
    expect(buildRuntimeChangePatch(undefined, 'builtin').runtimePreference).toEqual({
      family: 'integrated',
      id: 'claude-agent-sdk',
    });
    expect(buildRuntimeChangePatch(undefined, 'dsh').runtimePreference).toEqual({
      family: 'integrated',
      id: 'dsh',
    });
  });

  it('preserves envPolicy across runtime switches', () => {
    const patch = buildRuntimeChangePatch(
      {
        model: 'claude-sonnet-4-5',
        envPolicy: { proxy: 'terminal' },
      },
      'codex',
    );
    expect(patch.runtime).toBe('codex');
    expect(patch.runtimeConfig).toEqual({ envPolicy: { proxy: 'terminal' } });
  });

  it('returns runtimeConfig: undefined when scrub leaves an empty object', () => {
    const patch = buildRuntimeChangePatch(
      { model: 'claude-sonnet-4-5' },
      'codex',
    );
    expect(patch.runtimeConfig).toBeUndefined();
  });

  it('does not mutate the input runtimeConfig', () => {
    const input = {
      model: 'claude-sonnet-4-5',
      envPolicy: { proxy: 'terminal' as const },
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    buildRuntimeChangePatch(input, 'codex');
    expect(input).toEqual(snapshot);
  });
});
