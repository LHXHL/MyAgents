import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceSession, SpaceSessionView } from '@/api/spaceCloud';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(), updateProfile: vi.fn(), logout: vi.fn(), presets: vi.fn(),
  getOfficial: vi.fn(), listIssues: vi.fn(), listeners: [] as Array<{ handler: (event: { payload: string }) => void; signal: AbortSignal }>,
}));
vi.mock('@/api/spaceCloud', () => ({
  spaceGetSession: mocks.getSession, spaceUpdateProfile: mocks.updateProfile,
  spaceLogout: mocks.logout, spaceGetAvatarPresets: mocks.presets,
  spaceGetOfficial: mocks.getOfficial, spaceListIssues: mocks.listIssues,
  spaceErrorMessage: (error: unknown) => String(error),
}));
vi.mock('@/utils/tauriListen', () => ({
  listenWithCleanup: vi.fn(async (_name, handler, signal) => {
    mocks.listeners.push({ handler, signal });
  }),
}));
import { __resetAccountStoreForTest, accountActions, getAccountSnapshot, startAccountProjection } from './accountStore';

const session: SpaceSession = {
  sessionBindingId: 'binding-a', baseUrl: 'https://space.myagents.test',
  user: { id: 'user-a', name: 'Alice', email: 'alice@example.test' },
  space: { id: 'official', slug: 'official', name: 'Official', joinPolicy: 'open' },
  membership: { id: 'm-a', role: 'member' }, updatedAt: '2026-10-04T00:00:00Z',
};
const authenticated = (value = session): SpaceSessionView => ({ state: 'authenticated', session: value });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function event(payload: string) {
  for (const listener of mocks.listeners) if (!listener.signal.aborted) listener.handler({ payload });
}
let stop: (() => void) | undefined;
async function start() { stop = startAccountProjection('production', true); await settle(); }

describe('Shell account projection', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.listeners = [];
    __resetAccountStoreForTest();
    mocks.getSession.mockResolvedValue(authenticated());
    mocks.logout.mockResolvedValue(undefined);
    mocks.updateProfile.mockResolvedValue(session);
    mocks.presets.mockResolvedValue({ people: [], agents: [] });
  });
  afterEach(() => { stop?.(); stop = undefined; });

  it('reads only the account and never boots Space business data', async () => {
    await start();
    expect(getAccountSnapshot().view).toEqual(authenticated());
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    expect(mocks.getOfficial).not.toHaveBeenCalled();
    expect(mocks.listIssues).not.toHaveBeenCalled();
  });
  it('does not read accounts when the capability is unavailable', async () => {
    stop = startAccountProjection('production', false); await settle();
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.listeners).toHaveLength(0);
  });
  it('updates sign-in from the authority event without a Space Tab', async () => {
    mocks.getSession.mockResolvedValueOnce(null);
    await start();
    event('auth'); await settle();
    expect(getAccountSnapshot().view).toEqual(authenticated());
  });
  it('immediately clears the old identity and discards late reads on logout', async () => {
    await start();
    const old = deferred<SpaceSessionView>();
    mocks.getSession.mockReturnValueOnce(old.promise).mockResolvedValueOnce(null);
    const refresh = accountActions.refresh(true);
    event('auth');
    expect(getAccountSnapshot().view).toBeNull();
    await settle(); old.resolve(authenticated()); await refresh;
    expect(getAccountSnapshot().view).toBeNull();
    expect(getAccountSnapshot().loadState).toBe('ready');
  });
  it('isolates environment changes from outstanding reads and subscriptions', async () => {
    const old = deferred<SpaceSessionView>();
    mocks.getSession.mockReturnValueOnce(old.promise);
    await start(); stop?.();
    const dev = { ...session, baseUrl: 'https://dev.myagents.test', sessionBindingId: 'binding-dev' };
    mocks.getSession.mockResolvedValue(authenticated(dev));
    stop = startAccountProjection('dev', true); await settle();
    old.resolve(authenticated()); await settle();
    expect(getAccountSnapshot().scope).toBe('dev');
    expect(getAccountSnapshot().view).toEqual(authenticated(dev));
    expect(mocks.listeners[0].signal.aborted).toBe(true);
  });
  it('rejects late profile saves after identity changes', async () => {
    await start();
    const save = deferred<SpaceSession>(); mocks.updateProfile.mockReturnValueOnce(save.promise);
    const operation = accountActions.updateProfile({ name: 'Old changed' });
    const rejected = expect(operation).rejects.toThrow('Account changed');
    const next = { ...session, sessionBindingId: 'binding-b', user: { ...session.user, id: 'user-b', name: 'Bob' } };
    mocks.getSession.mockResolvedValue(authenticated(next)); event('auth'); await settle();
    save.resolve({ ...session, user: { ...session.user, name: 'Old changed' } });
    await rejected;
    expect(getAccountSnapshot().view).toEqual(authenticated(next));
  });
  it('does not let a late read overwrite a successful profile mutation', async () => {
    await start();
    const old = deferred<SpaceSessionView>(); mocks.getSession.mockReturnValueOnce(old.promise);
    const refresh = accountActions.refresh(true);
    const changed = { ...session, user: { ...session.user, name: 'New name' } };
    mocks.updateProfile.mockResolvedValue(changed);
    await accountActions.updateProfile({ name: 'New name' });
    old.resolve(authenticated()); await refresh;
    expect(getAccountSnapshot().view).toEqual(authenticated(changed));
  });
  it('preserves authenticated data on ordinary connection failures', async () => {
    await start(); mocks.getSession.mockRejectedValue(new Error('503 unavailable'));
    await accountActions.refresh(true);
    expect(getAccountSnapshot().view).toEqual(authenticated());
    expect(getAccountSnapshot().loadState).toBe('error');
  });
  it('consumes reauth from Rust and never guesses authentication from plan dates', async () => {
    await start();
    const reauth: SpaceSessionView = { state: 'reauth_required', account: session, invalidatedSessionBindingId: 'binding-a' };
    mocks.getSession.mockResolvedValue(reauth); await accountActions.refresh(true);
    expect(getAccountSnapshot().view).toEqual(reauth);
    await expect(accountActions.updateProfile({ name: 'No' })).rejects.toThrow('no longer signed in');
  });
  it('drops old avatar presets after account replacement', async () => {
    await start(); const old = deferred<{ people: []; agents: [] }>();
    mocks.presets.mockReturnValueOnce(old.promise);
    const loading = accountActions.loadAvatarPresets();
    mocks.getSession.mockResolvedValue(null); event('auth'); await settle();
    old.resolve({ people: [], agents: [] }); await loading;
    expect(getAccountSnapshot().avatarPresets.lastFetchedAt).toBe(0);
    expect(getAccountSnapshot().avatarPresets.isLoading).toBe(false);
  });
  it('preserves identity and reports a failed local logout', async () => {
    await start(); mocks.logout.mockRejectedValue(new Error('local removal failed'));
    await expect(accountActions.logout()).rejects.toThrow('local removal failed');
    expect(getAccountSnapshot().view).toEqual(authenticated());
  });
  it('does not clear a new sign-in when an old logout finishes late', async () => {
    await start(); const old = deferred<void>(); mocks.logout.mockReturnValueOnce(old.promise);
    const logout = accountActions.logout();
    const next = { ...session, sessionBindingId: 'binding-new' };
    mocks.getSession.mockResolvedValue(authenticated(next)); event('auth'); await settle();
    old.resolve(); await logout;
    expect(getAccountSnapshot().view).toEqual(authenticated(next));
  });
  it('releases listeners and rejects completions across mount/cleanup/remount', async () => {
    await start(); stop?.(); await start();
    expect(mocks.listeners.filter(({ signal }) => !signal.aborted)).toHaveLength(1);
  });
});
