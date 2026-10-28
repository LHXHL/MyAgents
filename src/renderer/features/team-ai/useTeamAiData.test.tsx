import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamChannel } from '@/../shared/teamAi';
import { useTeamAiData } from './useTeamAiData';

const mocks = vi.hoisted(() => ({ channels: vi.fn(), sessions: vi.fn(), states: vi.fn(), listeners: new Map<string, () => void>() }));
vi.mock('./client', () => ({ teamChannels: mocks.channels, teamStates: mocks.states }));
vi.mock('@/api/sessionClient', () => ({ getSessions: mocks.sessions }));
vi.mock('@/utils/tauriListen', () => ({ listenWithCleanup: vi.fn(async (name, fn, signal) => {
  mocks.listeners.set(name, fn);
  signal.addEventListener('abort', () => { if (mocks.listeners.get(name) === fn) mocks.listeners.delete(name); });
}) }));
const channel = (name: string) => ({ channelId: name, name, peers: [] }) as unknown as TeamChannel;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const flush = () => act(async () => { await Promise.resolve(); });
beforeEach(() => {
  vi.resetAllMocks(); mocks.listeners.clear(); vi.useFakeTimers();
  mocks.channels.mockResolvedValue({ channels: [channel('initial')] });
  mocks.sessions.mockResolvedValue([]); mocks.states.mockResolvedValue({ states: [] });
});
afterEach(() => { vi.useRealTimers(); });

describe('Team AI refresh ownership', () => {
  it('does not let a read begun before successful review restore stale approval controls', async () => {
    const waiting = { ...channel('c'), peers: [{ id: 'group:g', sourceId: 'g', sourceType: 'group' as const, name: 'Group', sessionKey: null, sessionId: null, sessionIds: [], hasProfile: false, access: 'pending' as const }] };
    mocks.channels.mockResolvedValue({ channels: [waiting] });
    const { result } = renderHook(() => useTeamAiData('agent', '/workspace', true));
    await flush();
    const old = deferred<{ channels: TeamChannel[] }>();
    mocks.channels.mockReturnValueOnce(old.promise);
    act(() => { void result.current.refresh(); });
    act(() => { result.current.reflectGroupReview('c', 'g', 'approve'); });
    await act(async () => { old.resolve({ channels: [waiting] }); });
    expect(result.current.channels[0].peers[0].access).toBe('approved');
  });
  it('publishes slow reads despite repeated events and coalesces a trailing read', async () => {
    const first = deferred<{ channels: TeamChannel[] }>();
    const second = deferred<{ channels: TeamChannel[] }>();
    mocks.channels.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useTeamAiData('agent', '/workspace', true));
    await act(async () => {
      mocks.listeners.get('im:user-bound')!();
      mocks.listeners.get('im:group-permission-changed')!();
      await vi.advanceTimersByTimeAsync(16000);
    });
    expect(mocks.channels).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve({ channels: [channel('slow-but-valid')] }); });
    expect(result.current.channels[0].name).toBe('slow-but-valid');
    expect(mocks.channels).toHaveBeenCalledTimes(2);
    await act(async () => { second.resolve({ channels: [channel('latest')] }); });
    expect(result.current.channels[0].name).toBe('latest');
    expect(mocks.channels).toHaveBeenCalledTimes(2);
  });

  it('publishes membership before slow metadata and preserves it if metadata fails', async () => {
    const metadata = deferred<never>();
    mocks.sessions.mockReturnValueOnce(metadata.promise);
    const { result, rerender } = renderHook(({ agent }) => useTeamAiData(agent, '/workspace', true), { initialProps: { agent: 'a' } });
    await flush();
    expect(result.current.channels[0].name).toBe('initial');
    expect(result.current.loaded).toBe(true);
    mocks.sessions.mockRejectedValueOnce(new Error('metadata unavailable'));
    rerender({ agent: 'b' });
    await flush();
    expect(result.current.channels[0].name).toBe('initial');
    expect(result.current.error).toContain('metadata unavailable');
  });

  it('ignores the previous Agent completion and queued notifications after switching', async () => {
    const old = deferred<{ channels: TeamChannel[] }>();
    mocks.channels.mockReturnValueOnce(old.promise);
    const { result, rerender } = renderHook(({ agent }) => useTeamAiData(agent, `/${agent}`, true), { initialProps: { agent: 'old' } });
    act(() => { mocks.listeners.get('im:bot-config-changed')!(); });
    mocks.channels.mockResolvedValue({ channels: [channel('new-agent')] });
    rerender({ agent: 'new' });
    await flush();
    await act(async () => { old.resolve({ channels: [channel('old-agent')] }); });
    expect(result.current.channels[0].name).toBe('new-agent');
    expect(mocks.channels).toHaveBeenCalledTimes(2);
  });

  it('refreshes on reactivation, focus and the eight-second fallback and cleans up', async () => {
    const { result, rerender, unmount } = renderHook(({ active }) => useTeamAiData('a', '/a', active), { initialProps: { active: true } });
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(mocks.channels).toHaveBeenCalledTimes(2);
    rerender({ active: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(16000); });
    expect(mocks.channels).toHaveBeenCalledTimes(2);
    expect(result.current.loaded).toBe(true);
    rerender({ active: true }); await flush();
    expect(mocks.channels).toHaveBeenCalledTimes(3);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(mocks.channels).toHaveBeenCalledTimes(4);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(16000); window.dispatchEvent(new Event('focus')); });
    expect(mocks.channels).toHaveBeenCalledTimes(4);
    expect(mocks.listeners.size).toBe(0);
  });
});
