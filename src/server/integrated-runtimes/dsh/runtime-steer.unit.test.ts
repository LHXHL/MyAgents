import { describe, expect, it, vi } from 'vitest';
import type { RuntimeProcess } from '../../runtimes/types';
import { DshRuntime } from './runtime';

describe('DSH realtime admission through the shared Runtime contract', () => {
  it('exposes native steering eligibility and withdraws it when the root settles or exits', () => {
    const runtime = new DshRuntime();
    const process: RuntimeProcess = {
      pid: 1, exited: false, writeLine: async () => {},
      kill: () => {}, waitForExit: async () => 0,
    };
    const root = vi.spyOn(runtime, 'getActiveRootOperation').mockReturnValue(null);
    expect(runtime.canSteerMessage(process)).toBe(false);
    root.mockReturnValue({ clientOperationId: 'root', realtimeSteerEligible: false });
    expect(runtime.canSteerMessage(process)).toBe(false);
    root.mockReturnValue({ clientOperationId: 'root', realtimeSteerEligible: true });
    expect(runtime.canSteerMessage(process)).toBe(true);
    root.mockReturnValue(null);
    expect(runtime.canSteerMessage(process)).toBe(false);
    root.mockReturnValue({ clientOperationId: 'root', realtimeSteerEligible: true });
    process.exited = true;
    expect(runtime.canSteerMessage(process)).toBe(false);
  });
});
