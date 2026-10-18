import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import routingIdentities from '../../shared/__fixtures__/channel-context/routing-identities.json';

import { createCompatRuntime } from './compat-runtime';
import { normalizeImInbound } from '../session-core/channel-context';
import {
  bindPendingStream,
  clearAllPendingDispatches,
  completePendingDispatch,
  enqueuePartial,
  enqueueRunStart,
  getPendingDispatch,
} from './pending-dispatch';
import {
  _getInheritedProxySnapshotForTests,
  _resetProxyStateForTests,
  getCurrentProxySettings,
} from '../proxy-state';
import { _setGeneralFetchTransportForTests } from '../utils/cancellation';

const originalProxySettings = getCurrentProxySettings();
const originalInheritedProxySnapshot = _getInheritedProxySnapshotForTests();

describe('plugin bridge compat runtime dispatch ownership', () => {
  beforeEach(() => {
    _resetProxyStateForTests(null, {});
    _setGeneralFetchTransportForTests(
      async (url, init) => globalThis.fetch(url, init as RequestInit),
    );
  });

  afterEach(() => {
    _resetProxyStateForTests(originalProxySettings, originalInheritedProxySnapshot);
    _setGeneralFetchTransportForTests();
    vi.unstubAllGlobals();
    clearAllPendingDispatches();
  });

  it.each(['protocol', 'buffered'] as const)('shares registered identity and inbound peer IDs with Rust handoffs (%s)', async path => {
    for (const row of routingIdentities) {
      const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{}'));
      vi.stubGlobal('fetch', fetchMock);
      const runtime = createCompatRuntime(31_426, 'bot', row.configured);
      runtime.setPluginId(row.registered);
      const ctx = { To: row.to, SenderId: 'sender', SenderName: 'Alice', Body: 'hello', ChatType: row.kind === 'group' ? 'group' : 'direct' };
      const pending = path === 'protocol'
        ? runtime.channel.reply.dispatchReplyFromConfig({ ctx, dispatcher: { sendFinalReply: () => true, markComplete: () => {}, getQueuedCounts: () => ({}) } })
        : runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({ ctx });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(body).toMatchObject({ botId: 'bot', pluginId: row.registered, chatId: row.inbound, chatType: row.kind === 'group' ? 'group' : 'direct' });
      if (body.requestId) completePendingDispatch(body.requestId, []);
      await pending;
    }
  });

  it.each(['protocol', 'buffered'] as const)('enriches sender before %s ingress while preserving body and route', async (path) => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const query = vi.fn(async () => ({ details: JSON.stringify({ sessions: [
      { chat_id: 'sender-1', chat_type: 'single', chat_name: 'Alice' },
      { chat_id: 'group-1', chat_type: 'group', chat_name: 'Team' },
    ] }) }));
    const runtime = createCompatRuntime(31_426, 'bot-1', 'wecom', query);
    const ctx = { To: 'wecom:group-1', SenderId: 'sender-1', SenderName: 'sender-1',
      AccountId: 'account-1', Body: 'original query', ChatType: 'group' };
    const pending = path === 'protocol'
      ? runtime.channel.reply.dispatchReplyFromConfig({ ctx, dispatcher: {
        sendFinalReply: () => true, markComplete: () => {}, getQueuedCounts: () => ({}),
      } })
      : runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({ ctx });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? '{}'));
    expect(body).toMatchObject({ senderId: 'sender-1', senderName: 'Alice', groupName: 'Team', chatId: 'group-1', text: 'original query', accountId: 'account-1' });
    expect(query).toHaveBeenCalledWith('account-1');
    expect(normalizeImInbound({ ...body, requestId: body.requestId ?? 'event', receivedAt: '2026-10-18T00:00:00Z' }).sender.name).toBe('Alice');
    if (body.requestId) completePendingDispatch(body.requestId, []);
    await pending;
  });

  it.each(['protocol', 'buffered'] as const)('projects QQ @ events on %s ingress without overriding explicit false', async path => {
    for (const explicit of [undefined, false]) {
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'));
      vi.stubGlobal('fetch', fetchMock);
      const runtime = createCompatRuntime(31_426, 'bot', 'qqbot');
      const ctx = { To: 'qqbot:g', SenderId: 'u', Body: 'hi', ChatType: 'group', IsMention: explicit };
      const pending = path === 'protocol'
        ? runtime.channel.reply.dispatchReplyFromConfig({ ctx, dispatcher: { sendFinalReply: () => true, markComplete: () => {}, getQueuedCounts: () => ({}) } })
        : runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({ ctx });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(body.isMention).toBe(explicit ?? true);
      if (body.requestId) completePendingDispatch(body.requestId, []);
      await pending;
    }
  });

  it('resolves Lark transport group IDs through the plugin directory before ingress', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const directory = vi.fn(async (kind, id) => [{ kind, id, name: 'Team' }]);
    const runtime = createCompatRuntime(31_426, 'bot', 'feishu', undefined, directory);
    const pending = runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({ctx:{ To: 'feishu:g', SenderId: 'u', SenderName: 'Alice', GroupSubject: 'g', Body: 'hi', ChatType: 'group', AccountId: 'account' }});
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.groupName).toBe('Team');
    expect(directory).toHaveBeenCalledWith('group', 'g', 'account');
    if (body.requestId) completePendingDispatch(body.requestId, []);
    await pending;
  });

  it('registers a request-scoped standard dispatcher before forwarding to Rust', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const runtime = createCompatRuntime(31_426, 'bot-1', 'openclaw-plugin-feishu');
    const events: string[] = [];
    const finalPayloads: Array<Record<string, unknown>> = [];
    const dispatchPromise = runtime.channel.reply.dispatchReplyFromConfig({
      ctx: {
        To: 'chat:peer-1',
        SenderId: 'sender-1',
        AccountId: 'account-1',
        Body: 'hello',
      },
      dispatcher: {
        sendFinalReply: (payload: Record<string, unknown>) => {
          finalPayloads.push(payload);
          return true;
        },
        markComplete: () => {},
        getQueuedCounts: () => ({ tool: 0, block: 0, final: finalPayloads.length }),
      },
      replyOptions: {
        onReplyStart: () => { events.push('start'); },
        onPartialReply: (payload: { text?: string }) => { events.push(`partial:${payload.text}`); },
      },
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const request = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body ?? '{}')) as Record<string, unknown>;
    expect(body).toMatchObject({
      chatId: 'peer-1',
      accountId: 'account-1',
      deliveryProtocol: 'openclaw-reply',
    });
    expect(typeof body.requestId).toBe('string');
    const requestId = String(body.requestId);
    expect(getPendingDispatch(requestId)).toBeDefined();

    enqueueRunStart(requestId);
    bindPendingStream(requestId, 'stream-1');
    enqueuePartial('stream-1', { text: 'answer' }, 'answer');
    completePendingDispatch(requestId, [{ text: 'answer' }]);

    await expect(dispatchPromise).resolves.toEqual({
      queuedFinal: 1,
      counts: { tool: 0, block: 0, final: 1 },
    });
    expect(events).toEqual(['start', 'partial:answer']);
    expect(finalPayloads).toEqual([{ text: 'answer' }]);
  });

  it('keeps completed delivery successful when post-idle diagnostics throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
        new Response('{}', { status: 200 })
      ));
      vi.stubGlobal('fetch', fetchMock);

      const runtime = createCompatRuntime(31_426, 'bot-1', 'openclaw-plugin-feishu');
      const dispatchPromise = runtime.channel.reply.dispatchReplyFromConfig({
        ctx: {
          To: 'chat:peer-1',
          SenderId: 'sender-1',
          Body: 'hello',
        },
        dispatcher: {
          sendFinalReply: () => true,
          markComplete: () => {},
          waitForIdle: async () => {},
          getQueuedCounts: () => { throw new Error('diagnostics unavailable'); },
        },
        replyOptions: {},
      });

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? '{}')) as Record<string, unknown>;
      completePendingDispatch(String(body.requestId), [{ text: 'answer' }]);

      await expect(dispatchPromise).resolves.toEqual({
        queuedFinal: 1,
        counts: { final: 1 },
      });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps buffered plugin delivery open until the AI terminal reaches its renderer', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const runtime = createCompatRuntime(31_426, 'bot-1', 'wecom-openclaw-plugin');
    const events: string[] = [];
    let releaseDelivery!: () => void;
    const deliveryGate = new Promise<void>(resolve => { releaseDelivery = resolve; });
    let settled = false;
    const dispatchPromise = runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: {
        To: 'chat:peer-1',
        SenderId: 'sender-1',
        AccountId: 'account-legacy',
        Body: 'hello',
      },
      dispatcherOptions: {
        onReplyStart: () => { events.push('thinking'); },
        deliver: async (payload: { text?: string }, info: { kind: string }) => {
          events.push(`${info.kind}:${payload.text}`);
          await deliveryGate;
          events.push('delivered');
        },
      },
    });
    void dispatchPromise.then(() => { settled = true; });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const request = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body ?? '{}')) as Record<string, unknown>;
    expect(body.deliveryProtocol).toBe('openclaw-reply');
    expect(typeof body.requestId).toBe('string');
    expect(body.accountId).toBe('account-legacy');
    expect(settled).toBe(false);

    const requestId = String(body.requestId);
    enqueueRunStart(requestId);
    completePendingDispatch(requestId, [{ text: 'answer' }]);
    await vi.waitFor(() => expect(events).toEqual(['thinking', 'final:answer']));
    expect(settled).toBe(false);
    releaseDelivery();
    await expect(dispatchPromise).resolves.toMatchObject({ queuedFinal: 1 });
    expect(events).toEqual(['thinking', 'final:answer', 'delivered']);
    expect(settled).toBe(true);
  });

  it('keeps buffered calls without a renderer on the legacy admission path', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const runtime = createCompatRuntime(31_426, 'bot-1', 'openclaw-plugin-yuanbao');
    await expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: { To: 'chat:peer-1', SenderId: 'sender-1', Body: 'hello' },
    })).resolves.toMatchObject({ queuedFinal: 0 });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? '{}')) as Record<string, unknown>;
    expect(body.deliveryProtocol).toBeUndefined();
    expect(body.requestId).toBeUndefined();
  });

  it('waits for the Yuanbao reply terminal and delivers through the plugin callback', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const runtime = createCompatRuntime(31_426, 'bot-1', 'openclaw-plugin-yuanbao');
    const deliver = vi.fn(async () => undefined);
    const onPartialReply = vi.fn(async () => undefined);
    const dispatch = runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: { To: 'chat:peer-1', SenderId: 'sender-1', Body: 'hello' },
      dispatcherOptions: { deliver },
      replyOptions: { onPartialReply },
    });
    let settled = false;
    void dispatch.then(() => { settled = true; });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? '{}')) as Record<string, unknown>;
    expect(body.deliveryProtocol).toBe('openclaw-reply');
    expect(typeof body.requestId).toBe('string');
    expect(settled).toBe(false);

    const requestId = String(body.requestId);
    enqueueRunStart(requestId);
    bindPendingStream(requestId, 'yuanbao-stream');
    enqueuePartial('yuanbao-stream', { text: 'answer' }, 'answer');
    completePendingDispatch(requestId, [{ text: 'answer' }]);

    await expect(dispatch).resolves.toMatchObject({ queuedFinal: 1 });
    expect(onPartialReply).toHaveBeenCalledWith({ text: 'answer' });
    expect(deliver).toHaveBeenCalledWith({ text: 'answer' }, { kind: 'final' });
  });

  it('leaves the Yuanbao fallback decision to an actually empty terminal', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const runtime = createCompatRuntime(31_426, 'bot-1', 'openclaw-plugin-yuanbao');
    const deliver = vi.fn(async () => undefined);
    const dispatch = runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: { To: 'chat:peer-1', SenderId: 'sender-1', Body: 'hello' },
      dispatcherOptions: { deliver },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? '{}')) as Record<string, unknown>;
    completePendingDispatch(String(body.requestId), []);
    await expect(dispatch).resolves.toMatchObject({ queuedFinal: 0 });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('preserves top-level account identity when standard callbacks fall back to legacy dispatch', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const runtime = createCompatRuntime(31_426, 'bot-1', 'openclaw-plugin-yuanbao');
    await expect(runtime.channel.reply.dispatchReplyFromConfig({
      ctx: {
        To: 'chat:peer-1',
        SenderId: 'sender-1',
        Body: 'hello',
      },
      accountId: 'account-top-level',
    })).resolves.toMatchObject({ queuedFinal: 0 });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? '{}')) as Record<string, unknown>;
    expect(body.accountId).toBe('account-top-level');
  });

  it('fails before registration when the plugin omits the reply destination', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const runtime = createCompatRuntime(31_426, 'bot-1', 'openclaw-plugin-feishu');
    await expect(runtime.channel.reply.dispatchReplyFromConfig({
      ctx: {
        SenderId: 'sender-1',
        Body: 'hello',
      },
      dispatcher: {
        sendFinalReply: () => true,
        markComplete: () => {},
      },
      replyOptions: {},
    })).rejects.toThrow('requires a reply destination');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the pending completion as the single setup-failure channel', async () => {
    const fetchMock = vi.fn(async () => new Response('unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const runtime = createCompatRuntime(31_426, 'bot-1', 'openclaw-plugin-feishu');
    await expect(runtime.channel.reply.dispatchReplyFromConfig({
      ctx: {
        To: 'chat:peer-1',
        SenderId: 'sender-1',
        Body: 'hello',
      },
      dispatcher: {
        sendFinalReply: () => true,
        markComplete: () => {},
      },
      replyOptions: {},
    })).rejects.toThrow('Rust returned 503: unavailable');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps explicit non-mention groups in the protocol so Rust owns activation', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const runtime = createCompatRuntime(31_426, 'bot-1', 'openclaw-plugin-feishu');
    const dispatchPromise = runtime.channel.reply.dispatchReplyFromConfig({
      ctx: {
        To: 'chat:group-1',
        ChatType: 'group',
        IsMention: false,
        SenderId: 'sender-1',
        Body: 'background chatter',
      },
      dispatcher: {
        sendFinalReply: () => true,
        markComplete: () => {},
      },
      replyOptions: {},
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const request = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body ?? '{}')) as Record<string, unknown>;
    expect(body).toMatchObject({
      chatType: 'group',
      chatId: 'group-1',
      isMention: false,
      deliveryProtocol: 'openclaw-reply',
    });
    const requestId = String(body.requestId);
    expect(getPendingDispatch(requestId)).toBeDefined();

    // Rust may choose an empty complete for mention-only admission, or run the
    // model when GroupActivation::Always is authoritative.
    completePendingDispatch(requestId, []);
    await expect(dispatchPromise).resolves.toEqual({
      queuedFinal: 0,
      counts: { final: 0 },
    });
  });
});
