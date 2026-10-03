import { randomUUID } from 'node:crypto';

import { runtimeTypeForBinding } from '../../shared/integrated-runtimes/identity';
import {
  beginDshDeleteMutation,
  deleteSession,
  deleteCommittedDshProduct,
  getSessionMetadata,
  recordCommittedDshDelete,
  recordPreparedDshDelete,
  type SessionDeleteResult,
} from '../SessionStore';
import {
  DshRuntime,
  getDshConversationMutationContext,
} from '../integrated-runtimes/dsh/runtime';
import type { RuntimeProcess } from '../runtimes/types';

function failedDelete(reason: Exclude<SessionDeleteResult, { deleted: true }>['reason']): SessionDeleteResult {
  return { deleted: false, reason };
}

function requireStoreSuccess<T>(
  result: { success: true; value: T } | { success: false; error: string },
): T {
  if (!result.success) throw new Error(result.error);
  return result.value;
}

/**
 * Execute DSH tombstone/purge before removing Product-owned metadata and JSONL.
 * Rust has already fenced Session owners before this global-sidecar entry runs.
 */
export async function deleteDshProductSession(sessionId: string): Promise<SessionDeleteResult> {
  const metadata = getSessionMetadata(sessionId);
  if (!metadata) return failedDelete('not-found');
  if (!metadata.runtimeBinding || runtimeTypeForBinding(metadata.runtimeBinding) !== 'dsh') {
    return failedDelete('precondition-failed');
  }
  if (!metadata.runtimeSessionId) return failedDelete('precondition-failed');

  const runtime = new DshRuntime();
  let process: RuntimeProcess | undefined;
  try {
    process = await runtime.startSession({
      sessionId,
      workspacePath: metadata.agentDir,
      systemPromptAppend: '',
      model: metadata.model,
      permissionMode: metadata.permissionMode,
      reasoningEffort: metadata.reasoningEffort,
      runtimeSource: 'integrated',
      resumeSessionId: metadata.runtimeSessionId,
      scenario: { type: 'desktop', surface: 'chat' },
    }, () => undefined);
  } catch {
    // Admission recovery can finish an interrupted delete and intentionally
    // leave no resumable Product Session.
    return getSessionMetadata(sessionId) ? failedDelete('io-error') : { deleted: true };
  }

  try {
    const context = getDshConversationMutationContext(process);
    if (context.runtimeSessionId !== metadata.runtimeSessionId) {
      return failedDelete('precondition-failed');
    }
    const existing = getSessionMetadata(sessionId)?.pendingDshMutation;
    const clientMutationId = existing?.kind === 'dsh-delete'
      ? existing.clientMutationId
      : `dsh-delete-${randomUUID()}`;
    let intent = requireStoreSuccess(await beginDshDeleteMutation({
      sessionId,
      clientMutationId,
    }));
    let mutation = intent.token
      ? await context.controller.deleteStatus(intent.token)
      : await context.controller.prepareDelete(clientMutationId);
    if (!intent.token) {
      intent = requireStoreSuccess(await recordPreparedDshDelete({
        sessionId,
        clientMutationId,
        token: mutation.token,
      }));
    }
    if (mutation.state === 'prepared') {
      mutation = await context.controller.commitDelete(clientMutationId, mutation.token);
    }
    if (mutation.state === 'committed') {
      intent = requireStoreSuccess(await recordCommittedDshDelete({
        sessionId,
        clientMutationId,
        token: mutation.token,
      }));
      mutation = await context.controller.purgeDelete(clientMutationId, mutation.token);
    }
    if (mutation.state !== 'purged') {
      throw new Error(`DSH delete settled as ${mutation.state}`);
    }
    if (intent.runtimeCommitted !== true) {
      requireStoreSuccess(await recordCommittedDshDelete({
        sessionId,
        clientMutationId,
        token: mutation.token,
      }));
    }
    requireStoreSuccess(await deleteCommittedDshProduct({
      sessionId,
      clientMutationId,
      token: mutation.token,
    }));
    return { deleted: true };
  } catch {
    return failedDelete('io-error');
  } finally {
    await runtime.stopSession(process).catch(() => undefined);
  }
}

/** Single SessionEngine deletion entry: routes never branch on Runtime family. */
export async function deleteProductSessionWithRuntime(
  sessionId: string,
): Promise<SessionDeleteResult> {
  const metadata = getSessionMetadata(sessionId);
  if (
    metadata?.runtimeBinding
    && runtimeTypeForBinding(metadata.runtimeBinding) === 'dsh'
  ) {
    return deleteDshProductSession(sessionId);
  }
  return deleteSession(sessionId, { kind: 'user-delete' });
}
