import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDshBinding } from '../../shared/integrated-runtimes/identity';
import { createSessionMetadata, type SessionMessage } from '../types/session';
import { snapshotForForkedSession } from '../utils/session-snapshot';

type SessionStoreModule = typeof import('../SessionStore');
type DshMutationRecoveryModule = typeof import('../session-engine/dsh-mutation-recovery');

let home: string;
let originalHome: string | undefined;
let store: SessionStoreModule;
let recovery: DshMutationRecoveryModule;

function messages(): SessionMessage[] {
  return [
    { id: 'user-1', role: 'user', content: 'one', timestamp: '2026-08-30T00:00:00.000Z' },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'first',
      timestamp: '2026-08-30T00:00:01.000Z',
      runtimeTurnAnchor: { turnId: 'turn-1', rootUserMessageId: 'user-1' },
    },
    { id: 'user-2', role: 'user', content: 'two', timestamp: '2026-08-30T00:00:02.000Z' },
    {
      id: 'assistant-2',
      role: 'assistant',
      content: 'second',
      timestamp: '2026-08-30T00:00:03.000Z',
      runtimeTurnAnchor: { turnId: 'turn-2', rootUserMessageId: 'user-2' },
    },
  ];
}

async function createDshSession(id: string): Promise<void> {
  const metadata = createSessionMetadata('/tmp/dsh-workspace', {
    id,
    runtimeBinding: createDshBinding('darwin-arm64'),
    runtimeSessionId: `runtime-${id}`,
    configSnapshotAt: '2026-08-30T00:00:00.000Z',
  });
  await store.saveSessionMetadata(metadata);
  const transcript = await store.loadSessionTranscript(id);
  const appended = await store.appendSessionMessages(id, transcript.cursor, messages());
  expect(appended.ok).toBe(true);
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'myagents-dsh-mutation-'));
  originalHome = process.env.HOME;
  process.env.HOME = home;
  vi.resetModules();
  store = await import('../SessionStore');
  recovery = await import('../session-engine/dsh-mutation-recovery');
});

afterAll(() => {
  process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe('DSH Product mutation journal', () => {
  it('keeps a fork hidden until Runtime and Product commit identities match', async () => {
    const sourceId = 'dsh-fork-source';
    const targetId = 'dsh-fork-target';
    await createDshSession(sourceId);

    const begun = await store.beginDshForkMutation({
      sourceSessionId: sourceId,
      sourceAssistantMessageId: 'assistant-1',
      clientMutationId: 'fork-mutation-1',
      targetProductSessionId: targetId,
      targetRuntimeSessionId: 'runtime-fork-target',
      targetRuntimeHome: '/tmp/dsh-fork-runtime-home',
      targetPersistenceRef: 'product-fork-target',
      targetWorkspaceIdentity: 'workspace-1',
    });
    expect(begun).toEqual(expect.objectContaining({ success: true }));
    if (!begun.success) return;
    expect(begun.value.targetMessages.map(message => message.id)).toEqual(['user-1', 'assistant-1']);

    await expect(store.recordPreparedDshFork({
      sourceSessionId: sourceId,
      clientMutationId: 'fork-mutation-1',
      token: 'fork-token-1',
      sourceStableBoundaryId: 'boundary-1',
    })).resolves.toMatchObject({ success: true });

    const target = createSessionMetadata('/tmp/dsh-workspace', snapshotForForkedSession(begun.value.source));
    target.id = targetId;
    target.runtimeSessionId = 'runtime-fork-target';
    target.materializationState = 'prepared';
    target.materializationSourceSessionId = sourceId;
    await expect(store.stageDshForkProduct({
      sourceSessionId: sourceId,
      clientMutationId: 'fork-mutation-1',
      targetMetadata: target,
      targetMessages: begun.value.targetMessages,
    })).resolves.toMatchObject({ success: true });
    expect(store.isHistoryVisibleSession(store.getSessionMetadata(targetId)!)).toBe(false);

    await expect(store.commitDshForkProduct({
      sourceSessionId: sourceId,
      clientMutationId: 'fork-mutation-1',
      token: 'fork-token-1',
    })).resolves.toMatchObject({ success: true });
    expect(store.getSessionMetadata(sourceId)?.pendingDshMutation).toBeUndefined();
    expect(store.isHistoryVisibleSession(store.getSessionMetadata(targetId)!)).toBe(true);
    expect(store.getSessionData(targetId)?.messages.map(message => message.id)).toEqual(['user-1', 'assistant-1']);
  });

  it('finishes Product rewind after a crash between JSONL replacement and index publication', async () => {
    const sessionId = 'dsh-rewind-source';
    await createDshSession(sessionId);
    const begun = await store.beginDshRewindMutation({
      sessionId,
      targetUserMessageId: 'user-2',
      clientMutationId: 'rewind-mutation-1',
    });
    expect(begun).toEqual(expect.objectContaining({ success: true }));
    if (!begun.success) return;
    expect(begun.value.intent.targetRuntimeTurnId).toBe('turn-1');

    await expect(store.recordPreparedDshRewind({
      sessionId,
      clientMutationId: 'rewind-mutation-1',
      token: 'rewind-token-1',
      targetStableBoundaryId: 'boundary-1',
      sourceTranscriptPostcondition: 'a'.repeat(64),
      targetTranscriptPostcondition: 'b'.repeat(64),
    })).resolves.toMatchObject({ success: true });

    const transcriptPath = join(home, '.myagents', 'sessions', `${sessionId}.jsonl`);
    writeFileSync(
      transcriptPath,
      `${begun.value.targetMessages.map(message => JSON.stringify(message)).join('\n')}\n`,
      'utf8',
    );
    expect(JSON.parse(readFileSync(join(home, '.myagents', 'sessions.json'), 'utf8')))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: sessionId, pendingDshMutation: expect.any(Object) }),
      ]));

    await expect(store.commitDshRewindProduct({
      sessionId,
      clientMutationId: 'rewind-mutation-1',
      token: 'rewind-token-1',
    })).resolves.toMatchObject({ success: true });
    expect(store.getSessionMetadata(sessionId)?.pendingDshMutation).toBeUndefined();
    expect(store.getSessionData(sessionId)?.messages.map(message => message.id)).toEqual(['user-1', 'assistant-1']);
  });

  it('replays exact fork prepare when the Runtime token was lost before Product fsync', async () => {
    const sourceId = 'dsh-fork-recovery-source';
    const targetId = 'dsh-fork-recovery-target';
    await createDshSession(sourceId);
    await expect(store.beginDshForkMutation({
      sourceSessionId: sourceId,
      sourceAssistantMessageId: 'assistant-1',
      clientMutationId: 'fork-recovery-1',
      targetProductSessionId: targetId,
      targetRuntimeSessionId: 'runtime-recovery-target',
      targetRuntimeHome: '/tmp/dsh-fork-recovery-home',
      targetPersistenceRef: 'product-recovery-target',
      targetWorkspaceIdentity: 'workspace-1',
    })).resolves.toMatchObject({ success: true });

    const prepareFork = vi.fn(async () => ({
      mutation: { token: 'fork-recovery-token', state: 'prepared' as const },
      boundary: {
        stableBoundaryId: 'boundary-1',
        sequence: 2,
        turn: 1,
        transcriptPostcondition: 'a'.repeat(64),
      },
    }));
    const commitFork = vi.fn(async () => ({
      token: 'fork-recovery-token',
      state: 'committed' as const,
    }));
    const controller = { prepareFork, commitFork };

    await expect(recovery.recoverPendingDshMutation({
      productSessionId: sourceId,
      runtimeSessionId: `runtime-${sourceId}`,
      binding: { state: 'recovery_required', unsettledMutations: ['fork'] },
      controller: controller as never,
    })).resolves.toEqual({ recovered: true, productDeleted: false });
    expect(prepareFork).toHaveBeenCalledWith(expect.objectContaining({
      clientMutationId: 'fork-recovery-1',
      targetRuntimeSessionId: 'runtime-recovery-target',
    }));
    expect(commitFork).toHaveBeenCalledWith('fork-recovery-1', 'fork-recovery-token');
    expect(store.getSessionMetadata(sourceId)?.pendingDshMutation).toBeUndefined();
    expect(store.isHistoryVisibleSession(store.getSessionMetadata(targetId)!)).toBe(true);
  });

  it('recovers a persisted fork abort decision without publishing a target', async () => {
    const sourceId = 'dsh-fork-abort-source';
    const targetId = 'dsh-fork-abort-target';
    await createDshSession(sourceId);
    await expect(store.beginDshForkMutation({
      sourceSessionId: sourceId,
      sourceAssistantMessageId: 'assistant-1',
      clientMutationId: 'fork-abort-1',
      targetProductSessionId: targetId,
      targetRuntimeSessionId: 'runtime-abort-target',
      targetRuntimeHome: '/tmp/dsh-fork-abort-home',
      targetPersistenceRef: 'product-abort-target',
      targetWorkspaceIdentity: 'workspace-1',
    })).resolves.toMatchObject({ success: true });
    await expect(store.recordPreparedDshFork({
      sourceSessionId: sourceId,
      clientMutationId: 'fork-abort-1',
      token: 'fork-abort-token',
      sourceStableBoundaryId: 'boundary-1',
    })).resolves.toMatchObject({ success: true });
    await expect(store.requestDshForkAbort({
      sourceSessionId: sourceId,
      clientMutationId: 'fork-abort-1',
      token: 'fork-abort-token',
    })).resolves.toMatchObject({ success: true });

    const forkStatus = vi.fn(async () => ({
      token: 'fork-abort-token',
      state: 'prepared' as const,
    }));
    const abortFork = vi.fn(async () => ({
      token: 'fork-abort-token',
      state: 'aborted' as const,
    }));
    await expect(recovery.recoverPendingDshMutation({
      productSessionId: sourceId,
      runtimeSessionId: `runtime-${sourceId}`,
      binding: { state: 'recovery_required', unsettledMutations: ['fork'] },
      controller: { forkStatus, abortFork } as never,
    })).resolves.toEqual({ recovered: true, productDeleted: false });

    expect(abortFork).toHaveBeenCalledWith('fork-abort-1', 'fork-abort-token');
    expect(store.getSessionMetadata(sourceId)?.pendingDshMutation).toBeUndefined();
    expect(store.getSessionMetadata(targetId)).toBeNull();
  });

  it('recovers delete through tombstone, purge, and Product removal', async () => {
    const sessionId = 'dsh-delete-recovery-source';
    await createDshSession(sessionId);
    await expect(store.beginDshDeleteMutation({
      sessionId,
      clientMutationId: 'delete-recovery-1',
    })).resolves.toMatchObject({ success: true });

    const prepareDelete = vi.fn(async () => ({
      token: 'delete-recovery-token',
      state: 'prepared' as const,
    }));
    const commitDelete = vi.fn(async () => ({
      token: 'delete-recovery-token',
      state: 'committed' as const,
    }));
    const purgeDelete = vi.fn(async () => ({
      token: 'delete-recovery-token',
      state: 'purged' as const,
    }));

    await expect(recovery.recoverPendingDshMutation({
      productSessionId: sessionId,
      runtimeSessionId: `runtime-${sessionId}`,
      binding: { state: 'recovery_required', unsettledMutations: ['delete'] },
      controller: { prepareDelete, commitDelete, purgeDelete } as never,
    })).resolves.toEqual({ recovered: true, productDeleted: true });
    expect(prepareDelete).toHaveBeenCalledWith('delete-recovery-1');
    expect(commitDelete).toHaveBeenCalledWith('delete-recovery-1', 'delete-recovery-token');
    expect(purgeDelete).toHaveBeenCalledWith('delete-recovery-1', 'delete-recovery-token');
    expect(store.getSessionMetadata(sessionId)).toBeNull();
  });
});
