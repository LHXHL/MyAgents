import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCompatRuntime } from './compat-runtime';
import { clearAllPendingDispatches, getPendingDispatch, resolvePendingDispatch } from './pending-dispatch';
import {
  _getInheritedProxySnapshotForTests,
  _resetProxyStateForTests,
  getCurrentProxySettings,
} from '../proxy-state';
import { _setGeneralFetchTransportForTests } from '../utils/cancellation';

const originalProxySettings = getCurrentProxySettings();
const originalInheritedProxySnapshot = _getInheritedProxySnapshotForTests();

describe('plugin bridge compat runtime fallback dispatch', () => {
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

  it('waits for a pending deliver callback instead of returning immediately', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

    const runtime = createCompatRuntime(31_426, 'bot-1', 'openclaw-plugin-yuanbao');
    const delivered: Array<{ text?: string; kind: string }> = [];
    let settled = false;

    const dispatchPromise = runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: {
        To: 'chat:peer-1',
        SenderId: 'sender-1',
        Body: 'hello',
      },
      dispatcherOptions: {
        deliver: async (payload: { text?: string }, info: { kind: string }) => {
          delivered.push({ text: payload.text, kind: info.kind });
        },
      },
    }).then((result) => {
      settled = true;
      return result;
    });

    for (let i = 0; i < 5 && !getPendingDispatch('peer-1'); i++) {
      await Promise.resolve();
    }
    expect(getPendingDispatch('peer-1')).toBeDefined();
    expect(settled).toBe(false);

    const pending = getPendingDispatch('peer-1');
    expect(pending?.resolveViaSendText).toBe(true);
    await pending?.callbacks.sendFinalReply({ text: 'answer' });
    resolvePendingDispatch('peer-1', { queuedFinal: 1, counts: { final: 1 } });

    await expect(dispatchPromise).resolves.toEqual({ queuedFinal: 1, counts: { final: 1 } });
    expect(delivered).toEqual([{ text: 'answer', kind: 'block' }]);
  });

  it('does not wait for explicit non-mention group messages', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const runtime = createCompatRuntime(31_426, 'bot-1', 'openclaw-plugin-feishu');

    await expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: {
        To: 'chat:group-1',
        ChatType: 'group',
        IsMention: false,
        SenderId: 'sender-1',
        Body: 'background chatter',
      },
      dispatcherOptions: {
        deliver: async () => {},
      },
    })).resolves.toEqual({ queuedFinal: 0, counts: {}, dispatcher: { waitForIdle: expect.any(Function) } });

    expect(getPendingDispatch('group-1')).toBeUndefined();
    const request = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body ?? '{}'))).toMatchObject({
      chatType: 'group',
      chatId: 'group-1',
      isMention: false,
    });
  });
});
