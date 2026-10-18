import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  metadata: undefined as Record<string, unknown> | undefined,
  data: undefined as { messages: unknown[] } | undefined,
  broadcast: vi.fn(),
}));

vi.mock('../../sse', () => ({
  broadcast: mocks.broadcast,
}));

vi.mock('../../SessionStore', () => ({
  getActiveSessionTranscript: vi.fn(() => undefined),
  getSessionMetadata: vi.fn(() => mocks.metadata),
  getSessionData: vi.fn(() => mocks.data),
  loadSessionTranscript: vi.fn(async () => ({
    messages: mocks.data?.messages ?? [],
    cursor: { persistedMessageCount: mocks.data?.messages.length ?? 0 },
    hasMalformedRows: false,
  })),
  appendSessionMessages: vi.fn(),
  mutateSessionTranscript: vi.fn(),
  saveSessionMetadata: vi.fn(),
  updateSessionMetadata: vi.fn(),
}));

import {
  hasPendingExternalAskUserQuestion,
  respondExternalPermission,
  respondExternalAskUserQuestion,
  respondExternalPlanApproval,
} from '../external-session';
import { setExternalActiveProcess, setExternalActiveRuntime, resetExternalLifecycleState } from './lifecycle';
import {
  getExternalInteractiveRequest,
  getExternalChannelInbound,
  deleteExternalInteractiveRequest,
  getExternalPermissionSuggestions,
  resetExternalInteractiveState,
  publishExternalChannelDeliveryPolicy,
  setExternalActiveRequestId,
  setExternalAskUserQuestion,
  setExternalInteractiveRequest,
  setExternalPermissionSuggestions,
} from './interactive';
import type { AgentRuntime, RuntimeProcess } from '../types';
import { normalizeImInbound } from '../../session-core/channel-context';
import { imRequestRegistry } from '../../utils/im-request-registry';
import { imEventBus, type ImEvent } from '../../utils/im-event-bus';

describe('external channel request association', () => {
  beforeEach(() => {
    resetExternalInteractiveState();
    imRequestRegistry.clear();
    imEventBus.clear();
  });

  afterEach(() => {
    resetExternalInteractiveState();
    imRequestRegistry.clear();
    imEventBus.clear();
  });

  it('reads the incoming request and publishes its mode before notifying, independently of the active request', () => {
    const active = imRequestRegistry.register('active', 'session');
    active.channelDeliveryMode = 'auto';
    setExternalActiveRequestId(active.requestId);
    const incoming = imRequestRegistry.register('incoming', 'session');
    incoming.channelInbound = normalizeImInbound({
      botId: 'bot', requestId: 'incoming', senderId: 'sender', receivedAt: '2026-10-18T00:00:00Z',
    });
    const events: ImEvent[] = [];
    imEventBus.subscribe(0, event => events.push(event));

    expect(getExternalChannelInbound('incoming')).toEqual(incoming.channelInbound);
    publishExternalChannelDeliveryPolicy('incoming', 'tool_only');

    expect(incoming.channelDeliveryMode).toBe('tool_only');
    expect(active.channelDeliveryMode).toBe('auto');
    expect(events).toEqual([expect.objectContaining({
      requestId: 'incoming', type: 'delivery-policy', channelDeliveryMode: 'tool_only',
    })]);
    expect(incoming.status).toBe('queued');
  });

  it('retains automatic delivery for a request without an explicit mode', () => {
    const request = imRequestRegistry.register('legacy', 'session');
    const events: ImEvent[] = [];
    imEventBus.subscribe(0, event => events.push(event));
    publishExternalChannelDeliveryPolicy(request.requestId, undefined);
    expect(request.channelDeliveryMode).toBe('auto');
    expect(events[0]).toMatchObject({ requestId: 'legacy', channelDeliveryMode: 'auto' });
  });

  it('does not borrow active request data or recreate a retired request', () => {
    const active = imRequestRegistry.register('active', 'session');
    active.channelDeliveryMode = 'auto';
    active.channelInbound = normalizeImInbound({
      botId: 'bot', requestId: 'active', senderId: 'other-sender', receivedAt: '2026-10-18T00:00:00Z',
    });
    setExternalActiveRequestId(active.requestId);
    imRequestRegistry.register('retired', 'session');
    imRequestRegistry.unregister('retired');
    const events: ImEvent[] = [];
    imEventBus.subscribe(0, event => events.push(event));
    expect(getExternalChannelInbound(undefined)).toBeUndefined();
    expect(getExternalChannelInbound('retired')).toBeUndefined();
    publishExternalChannelDeliveryPolicy(undefined, 'tool_only');
    expect(events).toEqual([]);
    publishExternalChannelDeliveryPolicy('retired', 'tool_only');
    expect(imRequestRegistry.get('retired')).toBeUndefined();
    expect(active.channelDeliveryMode).toBe('auto');
    expect(events).toEqual([expect.objectContaining({ requestId: 'retired', type: 'delivery-policy' })]);
    expect(events[0].channelDeliveryMode).toBeUndefined();
  });
});

describe('external interactive owner integration', () => {
  beforeEach(() => {
    resetExternalInteractiveState();
    resetExternalLifecycleState();
    mocks.broadcast.mockClear();
  });

  it('does not consume AskUserQuestion pending state when the runtime process is gone', async () => {
    const requestId = 'ask-process-gone';
    setExternalAskUserQuestion(requestId, {
      input: {
        questions: [
          {
            question: 'Continue?',
            header: 'Confirm',
            options: [{ label: 'Yes', description: 'Proceed' }],
            multiSelect: false,
          },
        ],
      },
    });
    setExternalInteractiveRequest(requestId, {
      type: 'ask-user-question:request',
      data: {
        requestId,
        questions: [
          {
            question: 'Continue?',
            header: 'Confirm',
            options: [{ label: 'Yes', description: 'Proceed' }],
            multiSelect: false,
          },
        ],
        previewFormat: 'html',
      },
    });

    await expect(respondExternalAskUserQuestion(requestId, { '0': 'Yes' })).resolves.toBe(false);
    expect(hasPendingExternalAskUserQuestion(requestId)).toBe(true);
  });

  it('keeps permission pending state when runtime delivery fails', async () => {
    const requestId = 'perm-delivery-fails';
    const respondPermission = vi.fn(async () => {
      throw new Error('stdin closed');
    });
    setExternalActiveProcess({
      pid: 123,
      exited: false,
      writeLine: vi.fn(async () => undefined),
      kill: vi.fn(),
      waitForExit: vi.fn(async () => 0),
    } satisfies RuntimeProcess, []);
    setExternalActiveRuntime({
      type: 'codex',
      respondPermission,
    } as unknown as AgentRuntime);
    setExternalPermissionSuggestions(requestId, ['suggested-rule']);
    setExternalInteractiveRequest(requestId, {
      type: 'permission:request',
      data: {
        requestId,
        toolName: 'Edit',
        toolUseId: 'tool-1',
        input: '{}',
      },
    });

    await expect(respondExternalPermission(requestId, 'always_allow')).rejects.toThrow('stdin closed');
    expect(getExternalPermissionSuggestions(requestId)).toEqual(['suggested-rule']);
    expect(getExternalInteractiveRequest(requestId)).toMatchObject({
      type: 'permission:request',
      data: { requestId },
    });
    expect(respondPermission).toHaveBeenCalledWith(
      expect.anything(),
      requestId,
      'always_allow',
      undefined,
      ['suggested-rule'],
    );
    expect(mocks.broadcast).not.toHaveBeenCalledWith('permission:expired', expect.anything());
  });

  it('broadcasts permission expiry after successful runtime delivery', async () => {
    const requestId = 'perm-delivery-ok';
    const respondPermission = vi.fn(async () => undefined);
    setExternalActiveProcess({
      pid: 123,
      exited: false,
      writeLine: vi.fn(async () => undefined),
      kill: vi.fn(),
      waitForExit: vi.fn(async () => 0),
    } satisfies RuntimeProcess, []);
    setExternalActiveRuntime({
      type: 'codex',
      respondPermission,
    } as unknown as AgentRuntime);
    setExternalInteractiveRequest(requestId, {
      type: 'permission:request',
      data: {
        requestId,
        toolName: 'Shell',
        toolUseId: 'tool-2',
        input: '{}',
      },
    });

    await expect(respondExternalPermission(requestId, 'allow_once')).resolves.toBe(true);

    expect(mocks.broadcast).toHaveBeenCalledWith('permission:expired', {
      requestId,
      reason: 'resolved',
      status: 'applied',
    });
    expect(getExternalInteractiveRequest(requestId)).toBeUndefined();
  });

  it('does not emit a duplicate expiry when the runtime resolves synchronously', async () => {
    const requestId = 'perm-runtime-resolved';
    const respondPermission = vi.fn(async () => {
      deleteExternalInteractiveRequest(requestId);
    });
    setExternalActiveProcess({
      pid: 123,
      exited: false,
      writeLine: vi.fn(async () => undefined),
      kill: vi.fn(),
      waitForExit: vi.fn(async () => 0),
    } satisfies RuntimeProcess, []);
    setExternalActiveRuntime({ type: 'dsh', respondPermission } as unknown as AgentRuntime);
    setExternalInteractiveRequest(requestId, {
      type: 'permission:request',
      data: { requestId, toolName: 'Bash', toolUseId: 'tool-3', input: '{}' },
    });

    await expect(respondExternalPermission(requestId, 'always_allow')).resolves.toBe(true);
    expect(mocks.broadcast).not.toHaveBeenCalledWith('permission:expired', expect.anything());
  });

  it('settles a DSH Plan review through the Runtime interaction owner', async () => {
    const requestId = 'dsh-plan-review';
    const respondPermission = vi.fn(async () => undefined);
    setExternalActiveProcess({
      pid: 123,
      exited: false,
      writeLine: vi.fn(async () => undefined),
      kill: vi.fn(),
      waitForExit: vi.fn(async () => 0),
    } satisfies RuntimeProcess, []);
    setExternalActiveRuntime({ type: 'dsh', respondPermission } as unknown as AgentRuntime);
    setExternalInteractiveRequest(requestId, {
      type: 'exit-plan-mode:request',
      data: { requestId, plan: '# Plan', allowedPrompts: [] },
    });

    await expect(respondExternalPlanApproval(requestId, false, 'Cover rollback')).resolves.toBe(true);
    expect(respondPermission).toHaveBeenCalledWith(
      expect.anything(),
      requestId,
      'deny',
      'Cover rollback',
      undefined,
      { approved: false, feedback: 'Cover rollback' },
    );
    expect(mocks.broadcast).toHaveBeenCalledWith('exit-plan-mode:expired', {
      requestId,
      reason: 'resolved',
    });
  });
});
