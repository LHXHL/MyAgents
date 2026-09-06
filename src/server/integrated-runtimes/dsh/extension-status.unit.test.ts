import { describe, expect, it } from 'vitest';
import { compileDshProductExtensionPlane } from './extension-compiler';
import { projectDshExtensionStatus } from './runtime';

const emptyPlane = compileDshProductExtensionPlane({ revision: 'fixture-v1', skills: [], commands: [], agents: [], mcpServers: [], dynamicTools: [] });
const plane = { ...emptyPlane, snapshot: { ...emptyPlane.snapshot, components: [
  { kind: 'skill' as const, id: 'manual', enabled: true, descriptor: { resourceId: "fixture-skill", description: "Fixture", rank: 1, invocation: { modelInvocable: false, userInvocable: true } } },
  { kind: 'agent' as const, id: 'helper', enabled: true, descriptor: { description: 'Fixture', prompt: 'Fixture', tools: [] } },
] }, diagnostics: [{ component: 'skill', id: 'unsupported', state: 'unsupported' as const, code: 'unsupported_context' }] };

describe('Runtime extension admission receipts', () => {
  it('preserves ready receipts and model invocation restrictions, and rejects compiler exclusions', () => {
    const status = projectDshExtensionStatus(plane, { desiredRevision: 'v1', effectiveRevision: 'v1', state: 'applied', components: [
      { key: 'skill:manual', state: 'ready' }, { key: 'agent:helper', state: 'ready' },
    ] });
    expect(status.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'manual', admission: 'ready', enabled: true, modelInvocable: false, effectiveGeneration: 'v1' }),
      expect.objectContaining({ id: 'helper', admission: 'ready', modelInvocable: true }),
      expect.objectContaining({ id: 'unsupported', admission: 'rejected', modelInvocable: false }),
    ]));
  });

  it('does not advertise a queued generation as currently callable', () => {
    const status = projectDshExtensionStatus(plane, { desiredRevision: 'v2', effectiveRevision: 'v1', state: 'queued', components: [
      { key: 'agent:helper', state: 'ready' },
    ] });
    const receipt = status.components.find(item => item.id === 'helper');
    expect(receipt).toMatchObject({ admission: 'pending', state: 'deferred_until_idle' });
    expect(receipt?.modelInvocable).toBeUndefined();
    expect(receipt?.effectiveGeneration).toBeUndefined();
    expect(status.effectiveRevision).toBe('v1');
  });
});
