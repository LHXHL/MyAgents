import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../sse', () => ({ broadcast: vi.fn() }));
vi.mock('./management-api-client', () => ({ managementApi: vi.fn(async () => ({ ok: true })) }));
import { broadcast } from '../sse';
import { managementApi } from './management-api-client';
import { broadcastAppConfigChanged } from './app-config-events';

describe('durable configuration App invalidation', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('reaches the native owner even when no renderer subscribes to this Sidecar', async () => {
    const payload = { section: 'agent-identity', action: 'register', agentId: 'test-agent' };
    expect(await broadcastAppConfigChanged(payload)).toEqual({ ok: true });
    expect(broadcast).toHaveBeenCalledWith('config:changed', payload);
    expect(managementApi).toHaveBeenCalledExactlyOnceWith('/api/app/config-changed', 'POST', {}, { timeoutMs: 2_000 });
  });
  it('reports notification failure without misreporting an already committed write as rolled back', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(managementApi).mockResolvedValueOnce({ ok: false, code: 'management_unavailable' });
    expect(await broadcastAppConfigChanged({ section: 'project', action: 'archive' })).toEqual({ ok: false, code: 'management_unavailable' });
    expect(broadcast).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });
});
