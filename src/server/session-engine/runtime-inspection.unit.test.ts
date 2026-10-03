import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ active: vi.fn(), installed: vi.fn() }));
vi.mock('./selector', () => ({ getSessionEngine: () => ({ inspectRuntime: mocks.active }) }));
vi.mock('../runtimes/factory', () => ({ getExternalRuntime: () => ({ inspectRuntime: mocks.installed }) }));
import { inspectRuntime } from './runtime-inspection';

beforeEach(() => { mocks.active.mockReset(); mocks.installed.mockReset(); });
describe('runtime inspection ownership', () => {
  it('preserves the lifecycle-owned observation when a process exists', async () => {
    mocks.active.mockResolvedValue({ runtime: 'dsh', process: { state: 'protocol-ready', identity: { runtimeGeneration: 'old-generation' } } });
    expect(await inspectRuntime('dsh')).toMatchObject({ process: { identity: { runtimeGeneration: 'old-generation' } } });
    expect(mocks.installed).not.toHaveBeenCalled();
  });
  it('inspects installation only when the current Session does not own that runtime', async () => {
    mocks.active.mockResolvedValue(null);
    mocks.installed.mockResolvedValue({ runtime: 'dsh', process: { state: 'not_running' } });
    expect(await inspectRuntime('dsh')).toMatchObject({ process: { state: 'not_running' } });
    expect(mocks.active).toHaveBeenCalledWith('dsh');
    expect(mocks.installed).toHaveBeenCalledExactlyOnceWith();
  });
});
