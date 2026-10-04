import {
  spaceErrorMessage,
  spaceGetAvatarPresets,
  spaceGetSession,
  spaceLogout,
  spaceUpdateProfile,
  type SpaceAvatarPreset,
  type SpaceSessionView,
} from '@/api/spaceCloud';
import { listenWithCleanup } from '@/utils/tauriListen';

export interface AccountAvatarPresets {
  people: SpaceAvatarPreset[];
  agents: SpaceAvatarPreset[];
  lastFetchedAt: number;
  isLoading: boolean;
  error: string | null;
}

export interface AccountSnapshot {
  scope: string;
  enabled: boolean;
  generation: number;
  loadState: 'idle' | 'loading' | 'ready' | 'error';
  view: SpaceSessionView | null;
  error: string | null;
  avatarPresets: AccountAvatarPresets;
}

const emptyPresets = (): AccountAvatarPresets => ({
  people: [], agents: [], lastFetchedAt: 0, isLoading: false, error: null,
});
const initial = (): AccountSnapshot => ({
  scope: '', enabled: false, generation: 0, loadState: 'idle',
  view: null, error: null, avatarPresets: emptyPresets(),
});
let snapshot = initial();
const listeners = new Set<() => void>();
let readSequence = 0;
let readPromise: Promise<void> | null = null;
let presetsSequence = 0;

function publish(patch: Partial<AccountSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

export function getAccountSnapshot(): AccountSnapshot { return snapshot; }
export function subscribeAccount(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function invalidateIdentity(loadState: AccountSnapshot['loadState']) {
  readSequence++;
  presetsSequence++;
  readPromise = null;
  publish({
    generation: snapshot.generation + 1, loadState,
    view: null, error: null, avatarPresets: emptyPresets(),
  });
}

function requireAccountGeneration() {
  if (!snapshot.enabled || snapshot.view?.state !== 'authenticated') {
    throw new Error('Account is no longer signed in');
  }
  return snapshot.generation;
}

function assertCurrent(generation: number) {
  if (snapshot.generation !== generation || !snapshot.enabled) {
    throw new Error('Account changed while the operation was in progress');
  }
}

export const accountActions = {
  refresh: (force = false): Promise<void> => {
    if (!snapshot.enabled) return Promise.resolve();
    if (readPromise && !force) return readPromise;
    const request = ++readSequence;
    const generation = snapshot.generation;
    publish({ loadState: 'loading', error: null });
    readPromise = (async () => {
      try {
        const view = await spaceGetSession();
        if (request !== readSequence || generation !== snapshot.generation) return;
        // A replaced binding must release all UI belonging to the old account,
        // even when the refresh was triggered without an auth notification.
        const oldView = snapshot.view;
        const oldBinding = oldView?.state === 'authenticated' ? oldView.session.sessionBindingId : null;
        const nextBinding = view?.state === 'authenticated' ? view.session.sessionBindingId : null;
        const changed = oldView !== null && (
          oldBinding !== nextBinding || oldView.state !== view?.state
          || (oldView.state === 'authenticated' && view?.state === 'authenticated'
            && (oldView.session.baseUrl !== view.session.baseUrl
              || oldView.session.user.id !== view.session.user.id))
        );
        if (changed) invalidateIdentity('loading');
        publish({ view, loadState: 'ready', error: null });
      } catch (error) {
        if (request !== readSequence || generation !== snapshot.generation) return;
        publish({ loadState: 'error', error: spaceErrorMessage(error) });
      } finally {
        if (request === readSequence) readPromise = null;
      }
    })();
    return readPromise;
  },

  updateProfile: async (input: Parameters<typeof spaceUpdateProfile>[0]): Promise<void> => {
    const generation = requireAccountGeneration();
    const session = await spaceUpdateProfile(input);
    assertCurrent(generation);
    readSequence++;
    readPromise = null;
    publish({ view: { state: 'authenticated', session }, loadState: 'ready', error: null });
  },

  loadAvatarPresets: async (options: { maxAgeMs?: number } = {}): Promise<void> => {
    const generation = requireAccountGeneration();
    const previous = snapshot.avatarPresets;
    if (previous.isLoading || (previous.lastFetchedAt > 0
      && Date.now() - previous.lastFetchedAt < (options.maxAgeMs ?? 0))) return;
    const request = ++presetsSequence;
    publish({ avatarPresets: { ...previous, isLoading: true, error: null } });
    try {
      const result = await spaceGetAvatarPresets();
      if (generation !== snapshot.generation || request !== presetsSequence) return;
      publish({ avatarPresets: { ...result, lastFetchedAt: Date.now(), isLoading: false, error: null } });
    } catch (error) {
      if (generation !== snapshot.generation || request !== presetsSequence) return;
      publish({ avatarPresets: { ...previous, isLoading: false, error: spaceErrorMessage(error) } });
    }
  },

  logout: async (): Promise<void> => {
    const generation = requireAccountGeneration();
    await spaceLogout();
    // Rust publishes auth invalidation after local removal. If it arrived
    // already, it owns the new state; never clear a subsequently logged-in user.
    if (generation === snapshot.generation) {
      invalidateIdentity('ready');
    }
  },
};

/** One Shell lifetime; subscribers (including Space) never start Space boot. */
export function startAccountProjection(scope: string, enabled: boolean): () => void {
  invalidateIdentity(enabled ? 'loading' : 'ready');
  publish({ scope, enabled });
  const ac = new AbortController();
  if (enabled) {
    // Register before reading so login/exit cannot disappear in the cold path.
    void listenWithCleanup<'auth' | 'profile'>(
      'space-account:changed',
      (event) => {
        if (event.payload === 'auth') invalidateIdentity('loading');
        void accountActions.refresh(true);
      },
      ac.signal,
    ).then(() => {
      if (!ac.signal.aborted) void accountActions.refresh();
    });
  }
  return () => {
    ac.abort();
    invalidateIdentity('idle');
    publish({ enabled: false });
  };
}

export function __resetAccountStoreForTest() {
  readSequence++;
  presetsSequence++;
  readPromise = null;
  snapshot = initial();
  listeners.clear();
}
