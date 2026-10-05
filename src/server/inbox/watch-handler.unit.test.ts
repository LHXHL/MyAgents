import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ metadata: vi.fn(), data: vi.fn(), fetch: vi.fn() }));
vi.mock('../SessionStore', () => ({ getSessionMetadata: mocks.metadata, getSessionData: mocks.data }));
vi.mock('../utils/cancellation', () => ({ cancellableFetch: mocks.fetch }));
import { handleAdminSessionWatch, projectSessionWatchManagement } from './watch-handler';
import { clearPendingSessionWatchesForTest, manageLocalSessionWatches, registerPendingSessionWatch } from './watch-registry';

beforeEach(() => {
  vi.stubEnv('MYAGENTS_MANAGEMENT_PORT', '31500');
  mocks.metadata.mockReset().mockImplementation(id => id === 'caller' ? { id, agentDir: '/synthetic' } : null);
  mocks.data.mockReset().mockResolvedValue(null);
  mocks.fetch.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe('cross-process Session watch existence', () => {
  it('watches an accepted live target whose V2 metadata is unpublished in the caller process', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, result: {
      watchId: 'watch', targetSessionId: 'target', targetStateAtRegistration: 'running', delivery: 'registered',
    } })));
    expect(await handleAdminSessionWatch('caller', { targetSessionId: 'target' })).toMatchObject({
      status: 200, response: { watched: true, delivery: 'registered' },
    });
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toMatchObject({ watcherSessionId: 'caller', targetSessionId: 'target' });
  });

  it('keeps a truly missing target a 404 after the lifecycle owner checks it', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, result: {
      watchId: 'watch', targetSessionId: 'deleted', targetStateAtRegistration: 'idle', delivery: 'not_found',
    } })));
    expect(await handleAdminSessionWatch('caller', { targetSessionId: 'deleted' })).toMatchObject({
      status: 404, response: { watched: false, error: { code: 'session_not_found' } },
    });
  });
});

describe('Session observation management receipts', () => {
  afterEach(clearPendingSessionWatchesForTest);

  it('wraps listing in data and rejects a missing or foreign caller watch without removing others', () => {
    for (const [watchId, watcherSessionId] of [['mine', 'caller'], ['foreign', 'other']]) {
      registerPendingSessionWatch({ watchId, watcherSessionId, targetSessionId: 'target', targetLabel: 'target', targetStateAtRegistration: 'running', registeredAt: '2026-10-05' });
    }
    expect(projectSessionWatchManagement({ watches: manageLocalSessionWatches('caller') })).toMatchObject({ success: true, data: { watches: [{ watchId: 'mine' }] } });
    for (const id of ['missing', 'foreign']) {
      expect(projectSessionWatchManagement({ watches: manageLocalSessionWatches('caller', id) }, id)).toMatchObject({ success: false, code: 'WATCH_NOT_FOUND', data: { watches: [] } });
    }
    expect(manageLocalSessionWatches('caller')).toHaveLength(1);
    expect(manageLocalSessionWatches('other')).toHaveLength(1);
    expect(projectSessionWatchManagement({ watches: manageLocalSessionWatches('caller', 'mine') }, 'mine')).toMatchObject({ success: true, data: { watches: [{ watchId: 'mine', cancelled: true }] } });
    expect(manageLocalSessionWatches('caller')).toHaveLength(0);
  });

  it.each(['registrationPending', 'deliveryPending'])('does not claim cancellation during %s', pending => {
    const watch = { watchId: 'pending', source: 'network', cancelled: false, [pending]: true };
    expect(projectSessionWatchManagement({ watches: [watch] }, 'pending')).toMatchObject({ success: false, code: 'WATCH_NOT_CANCELLED', data: { watches: [watch] } });
    expect(projectSessionWatchManagement({ watches: [{ watchId: 'done', cancelled: true }, watch] }, undefined, true)).toMatchObject({ success: false, code: 'WATCH_NOT_CANCELLED', data: { watches: [{ watchId: 'done', cancelled: true }, watch] } });
  });

  it('accepts an empty --all but fails closed on an invalid owner response', () => {
    expect(projectSessionWatchManagement({ watches: [] }, undefined, true)).toEqual({ success: true, data: { watches: [] } });
    expect(projectSessionWatchManagement({})).toMatchObject({ success: false, code: 'WATCH_OWNER_INVALID_RESPONSE' });
  });
});
