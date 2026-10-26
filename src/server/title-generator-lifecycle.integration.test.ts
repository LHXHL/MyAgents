import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexRuntime } from './runtimes/codex';
import type { RuntimeProcess, UnifiedEventCallback } from './runtimes/types';
import { generateTitleExternal } from './title-generator';

describe('Codex title lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('stops the owned process when input acknowledgement exceeds the title deadline', async () => {
    const process = { exited: false } as RuntimeProcess;
    const pending = Promise.withResolvers<void>();
    const start = vi.spyOn(CodexRuntime.prototype, 'startSession').mockResolvedValue(process);
    const send = vi.spyOn(CodexRuntime.prototype, 'sendMessage').mockReturnValue(pending.promise);
    const stop = vi.spyOn(CodexRuntime.prototype, 'stopSession').mockImplementation(async () => {
      process.exited = true;
      pending.reject(new Error('Client destroyed'));
    });
    const title = generateTitleExternal([{ user: 'question', assistant: 'answer' }], 'codex', 'fixture', '/fixture');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(start.mock.calls[0][0]).not.toHaveProperty('initialTurn');
    expect(send).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(title).resolves.toBeNull();
    expect(stop).toHaveBeenCalledWith(process);
  });

  it('cleans up a late startup without sending a title prompt', async () => {
    const process = { exited: false } as RuntimeProcess;
    const startup = Promise.withResolvers<RuntimeProcess>();
    vi.spyOn(CodexRuntime.prototype, 'startSession').mockReturnValue(startup.promise);
    const send = vi.spyOn(CodexRuntime.prototype, 'sendMessage');
    const stop = vi.spyOn(CodexRuntime.prototype, 'stopSession').mockResolvedValue();
    const title = generateTitleExternal([{ user: 'question', assistant: 'answer' }], 'codex', 'fixture', '/fixture');
    await vi.advanceTimersByTimeAsync(35_001);
    await expect(title).resolves.toBeNull();
    startup.resolve(process);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledWith(process);
  });

  it('returns the completed title and releases its temporary process', async () => {
    const process = { exited: false } as RuntimeProcess;
    let onEvent: UnifiedEventCallback;
    vi.spyOn(CodexRuntime.prototype, 'startSession').mockImplementation(async (_options, callback) => {
      onEvent = callback;
      return process;
    });
    vi.spyOn(CodexRuntime.prototype, 'sendMessage').mockImplementation(async () => {
      onEvent({ kind: 'text_delta', text: 'Codex 超时修复' });
      onEvent({ kind: 'turn_complete', status: 'success' });
    });
    const stop = vi.spyOn(CodexRuntime.prototype, 'stopSession').mockResolvedValue();
    await expect(generateTitleExternal([{ user: 'question', assistant: 'answer' }], 'codex', 'fixture', '/fixture'))
      .resolves.toBe('Codex 超时修复');
    expect(stop).toHaveBeenCalledWith(process);
    expect(vi.getTimerCount()).toBe(0);
  });
});
