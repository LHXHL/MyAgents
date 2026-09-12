import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CliProxyStatus } from '../../shared/cliproxy';
import { useCliProxyStatus } from './useCliProxyStatus';

const native = vi.hoisted(() => ({ status: vi.fn(), listen: vi.fn() }));
vi.mock('@/config/services/cliproxyService', () => ({ getCliProxyStatus: native.status }));
vi.mock('@/utils/tauriListen', () => ({ listenWithCleanup: native.listen }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it('ignores a late status response and unmounts without cancelling Rust account work', async () => {
  vi.useFakeTimers();
  const resolve: Array<(value: CliProxyStatus) => void> = [];
  native.status.mockImplementation(() => new Promise(done => { resolve.push(done); }));
  const { result, unmount } = renderHook(() => useCliProxyStatus());
  act(() => { vi.advanceTimersByTime(2_000); });
  const current = { error: null, models: [] } as unknown as CliProxyStatus;
  await act(async () => { resolve[1](current); });
  await act(async () => { resolve[0]({ ...current, error: { code: 'old', message: 'stale' } }); });
  expect(result.current.status).toBe(current);
  act(() => { vi.advanceTimersByTime(2_000); });
  const signal = native.listen.mock.calls[0][2] as AbortSignal;
  unmount();
  await act(async () => { resolve[2](current); });
  expect(signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
