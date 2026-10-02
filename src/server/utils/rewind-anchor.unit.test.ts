import { describe, it, expect } from 'vitest';
import { deriveReloadResumeAnchor, isRejectedReloadAnchor, resolveEffectiveResumeAt, type ReloadAnchorMessage } from './rewind-anchor';
import { nativeResumeBoundaryRecoveryMessage } from '../../shared/nativeResumeBoundary';

it('recognizes an SDK native boundary refusal without exposing its UUID', () => {
  const message = nativeResumeBoundaryRecoveryMessage('No message found with message.uuid of: sensitive-uuid');
  expect(message).toContain('会话恢复点已失效');
  expect(message).not.toContain('sensitive-uuid');
  expect(nativeResumeBoundaryRecoveryMessage('Provider unavailable')).toBeNull();
});

const m = (role: 'user' | 'assistant', sdkUuid?: string): ReloadAnchorMessage => ({ role, sdkUuid });

describe('deriveReloadResumeAnchor (PRD 0.2.27 window-B reconcile)', () => {
  it('window B: store truncated to end-on-assistant, tail uuid known → returns it', () => {
    // rewind truncated [1..50]; store ends on assistant a50; SDK file still has the
    // old tail → without this anchor the AI would reload the full pre-rewind history.
    const messages = [m('user', 'u1'), m('assistant', 'a1'), m('user', 'u2'), m('assistant', 'a50')];
    expect(deriveReloadResumeAnchor(messages, new Set(['u1', 'a1', 'u2', 'a50']))).toBe('a50');
  });

  it('no-op case: normal session whose tail is an assistant → returns tail uuid', () => {
    // When tail == SDK newest leaf, slicing the reconstructed chain at the tail
    // returns the whole chain → functionally a no-op, just made explicit.
    const messages = [m('user', 'u1'), m('assistant', 'a1')];
    expect(deriveReloadResumeAnchor(messages, new Set(['u1', 'a1']))).toBe('a1');
  });

  it('decision 3 gate: tail is an UNANSWERED user message → undefined (must not slice it out)', () => {
    const messages = [m('user', 'u1'), m('assistant', 'a1'), m('user', 'u2')];
    expect(deriveReloadResumeAnchor(messages, new Set(['u1', 'a1', 'u2']))).toBeUndefined();
  });

  it('decision 4 gate: tail uuid not in known-valid set (compacted/stale) → undefined', () => {
    const messages = [m('user', 'u1'), m('assistant', 'a50')];
    expect(deriveReloadResumeAnchor(messages, new Set(['u1']))).toBeUndefined();
  });

  it('tail assistant without an sdkUuid (old storage / not stamped) → undefined', () => {
    const messages = [m('user', 'u1'), m('assistant', undefined)];
    expect(deriveReloadResumeAnchor(messages, new Set(['u1']))).toBeUndefined();
  });

  it('empty store → undefined', () => {
    expect(deriveReloadResumeAnchor([], new Set())).toBeUndefined();
  });

  it('does not re-derive an evicted anchor during the same session load', () => {
    // SDK rejection clears the load-captured candidate and evicts its local
    // observation. A later disk reload can observe it again; that is a new run.
    const messages = [m('user', 'u1'), m('assistant', 'a50')];
    const valid = new Set(['u1', 'a50']);
    expect(deriveReloadResumeAnchor(messages, valid)).toBe('a50'); // first derive — sent, then rejected
    valid.delete('a50');                                            // recovery eviction
    expect(deriveReloadResumeAnchor(messages, valid)).toBeUndefined(); // retry won't re-derive it
  });
});

describe('isRejectedReloadAnchor', () => {
  it('matches only the exact derived UUID rejected by native resume', () => {
    expect(isRejectedReloadAnchor('Claude Code returned an error result: No message found with message.uuid of: tail-2', 'tail-2')).toBe(true);
    expect(isRejectedReloadAnchor('No message found with message.uuid of: tail-20', 'tail-2')).toBe(false);
    expect(isRejectedReloadAnchor('No conversation found', 'tail-2')).toBe(false);
    expect(isRejectedReloadAnchor('No message found with message.uuid of: tail-2')).toBe(false);
  });
});

describe('resolveEffectiveResumeAt (priority fold — locks the invariant the fork PRD must not regress)', () => {
  it('normal: only a reload anchor → uses it (lowest priority but nothing else set)', () => {
    expect(resolveEffectiveResumeAt({ forkMode: false, reloadAnchor: 'r1' })).toBe('r1');
  });

  it('normal: in-process rewind WINS over the reload anchor (existing rewind unchanged)', () => {
    expect(resolveEffectiveResumeAt({ forkMode: false, rewindResumeAt: 'rw1', reloadAnchor: 'r1' })).toBe('rw1');
  });

  it('normal: nothing set → undefined (bare resume)', () => {
    expect(resolveEffectiveResumeAt({ forkMode: false })).toBeUndefined();
  });

  it('fork: NEVER uses the reload anchor — falls to the fork point', () => {
    expect(resolveEffectiveResumeAt({ forkMode: true, forkResumeAt: 'f1', reloadAnchor: 'r1' })).toBe('f1');
  });

  it('fork: rewind anchor wins over the fork point', () => {
    expect(resolveEffectiveResumeAt({ forkMode: true, rewindResumeAt: 'rw1', forkResumeAt: 'f1' })).toBe('rw1');
  });

  it('fork: only a (defensive) reload anchor set → undefined (fork path ignores it)', () => {
    expect(resolveEffectiveResumeAt({ forkMode: true, reloadAnchor: 'r1' })).toBeUndefined();
  });
});
