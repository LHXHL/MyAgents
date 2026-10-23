import { describe, expect, it, vi } from 'vitest';
import { forwardLarkQuestion, larkQuestionDeliveryResponse } from './lark-questions';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const shim = await import(pathToFileURL(resolve('src/server/plugin-bridge/sdk-shim/plugin-sdk/plugin-runtime.js')).href);

describe('Lark Runtime question transport', () => {
  it.each([{ messageId: '' }, {}])('rejects resolved sends without a message ID: %j', async result => {
    const response = larkQuestionDeliveryResponse(await Promise.resolve(result));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false });
  });

  it('acknowledges the platform message ID after successful delivery', async () => {
    const response = larkQuestionDeliveryResponse({ messageId: 'om_question' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, messageId: 'om_question' });
  });

  it.each(['answer', 'cancel'])('forwards %s through the installed plugin callback contract', async action => {
    shim.clearPluginInteractiveHandlers();
    const forward = vi.fn().mockResolvedValue(undefined);
    expect(shim.registerPluginInteractiveHandler('myagents', {
      channel: 'feishu', namespace: 'myagents_question',
      handler: (context: Parameters<typeof forwardLarkQuestion>[0]) => forwardLarkQuestion(context, forward),
    })).toEqual({ ok: true });
    let cardResponse: unknown;
    const result = await shim.dispatchPluginInteractiveHandler({
      channel: 'feishu', data: `myagents_question:${action}`,
      invoke: async (match: { registration: { handler: (context: unknown) => Promise<unknown> }; namespace: string; payload: string }) => {
        cardResponse = await match.registration.handler({ ...match, senderId: 'requester',
          rawEvent: { action: { value: { rid: 'runtime-question-id', answers: { choice: '自己的答案' } } } } });
        return { handled: cardResponse !== undefined };
      },
    });
    expect(result).toMatchObject({ matched: true, handled: true });
    expect(forward).toHaveBeenCalledExactlyOnceWith({ requestId: 'runtime-question-id', userId: 'requester',
      answers: action === 'cancel' ? null : { choice: '自己的答案' } });
    expect(cardResponse).toEqual({ toast: { type: 'info', content: '回答已收到' } });
  });

  it('does not consume another plugin namespace, or accept a callback without an operator', async () => {
    const invoke = vi.fn();
    expect(await shim.dispatchPluginInteractiveHandler({ channel: 'feishu', data: 'oauth:answer', invoke }))
      .toMatchObject({ matched: false });
    expect(invoke).not.toHaveBeenCalled();
    const forward = vi.fn();
    expect(await forwardLarkQuestion({ payload: 'answer', rawEvent: { action: { value: { rid: 'id', answers: { '0': 'A' } } } } }, forward))
      .toMatchObject({ toast: { type: 'error' } });
    expect(forward).not.toHaveBeenCalled();
  });

  it('propagates delivery failure without announcing success and permits retry', async () => {
    const context = { payload: 'answer', senderId: 'u', rawEvent: { action: { value: { rid: 'r', answers: { '0': 'B' } } } } };
    const forward = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
    await expect(forwardLarkQuestion(context, forward)).rejects.toThrow('offline');
    await expect(forwardLarkQuestion(context, forward)).resolves.toMatchObject({ toast: { type: 'info' } });
    expect(forward).toHaveBeenCalledTimes(2);
  });
});
