import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { installLarkAdmissionRuntimeGlobals, markCurrentPluginInboundAccepted } from './lark-admission';
import { patchWecomChatQueueSource } from './plugin-compat-patches';
import { abortPendingDispatch, registerPendingDispatch, setPendingDispatchDeliveryMode } from './pending-dispatch';

const source = readFileSync(new URL('./fixtures/wecom-chat-queue-2026.9.15.txt', import.meta.url), 'utf8');
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function loadQueue() {
  installLarkAdmissionRuntimeGlobals();
  const patched = patchWecomChatQueueSource(source);
  expect(patched).not.toBeNull();
  return new Function(`${patched!.replaceAll('export function', 'function')}; return { enqueueWeComChatTask, hasActiveTask };`)() as {
    enqueueWeComChatTask(params: { accountId: string; chatId: string; task: () => Promise<void> }): { promise: Promise<void> };
    hasActiveTask(key: string): boolean;
  };
}

it('does not guess at an unknown WeCom queue source revision', () => {
  expect(patchWecomChatQueueSource(source + '\n')).toBeNull();
});

describe('WeCom admission/completion separation (#678)', () => {
  it('admits an answer before the original task completes and preserves both renderers', async () => {
    const queue = loadQueue();
    const firstEntered = deferred();
    const secondEntered = deferred();
    const accept = deferred();
    const deliveries: string[] = [];
    const first = queue.enqueueWeComChatTask({ accountId: 'a', chatId: 'chat', task: async () => {
      const completion = registerPendingDispatch('wecom-first', 'chat', {
        sendFinalReply: payload => { deliveries.push(`first:${payload.text}`); return true; },
      });
      firstEntered.resolve();
      await accept.promise;
      expect(markCurrentPluginInboundAccepted()).toBe(true);
      await completion;
    } });
    await firstEntered.promise;
    const second = queue.enqueueWeComChatTask({ accountId: 'a', chatId: 'chat', task: async () => {
      const completion = registerPendingDispatch('wecom-answer', 'chat', {
        sendFinalReply: payload => { deliveries.push(`second:${payload.text}`); return true; },
      });
      setPendingDispatchDeliveryMode('wecom-answer', 'tool_only');
      markCurrentPluginInboundAccepted();
      secondEntered.resolve();
      await completion;
    } });
    accept.resolve();
    await secondEntered.promise;
    expect(queue.hasActiveTask('a:chat')).toBe(true);
    abortPendingDispatch('wecom-answer', { text: 'hidden' });
    await second.promise;
    expect(queue.hasActiveTask('a:chat')).toBe(true);
    abortPendingDispatch('wecom-first', { text: 'producer lost' });
    await first.promise;
    expect(deliveries).toEqual(['first:producer lost']);
    expect(queue.hasActiveTask('a:chat')).toBe(false);
  });

  it('releases admission on setup failure and isolates accounts/chats', async () => {
    const queue = loadQueue();
    const gate = deferred();
    const entered = deferred();
    const blocked = queue.enqueueWeComChatTask({ accountId: 'a', chatId: 'one', task: () => gate.promise });
    const independent = queue.enqueueWeComChatTask({ accountId: 'a', chatId: 'two', task: async () => { entered.resolve(); } });
    await entered.promise;
    await independent.promise;
    const failed = queue.enqueueWeComChatTask({ accountId: 'b', chatId: 'one', task: async () => { throw new Error('setup'); } });
    await expect(failed.promise).rejects.toThrow('setup');
    const next = queue.enqueueWeComChatTask({ accountId: 'b', chatId: 'one', task: async () => {} });
    await next.promise;
    gate.resolve();
    await blocked.promise;
    expect(queue.hasActiveTask('a:one')).toBe(false);
  });
});
