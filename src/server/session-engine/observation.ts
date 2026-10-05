import type { SessionEngineLiveState } from './types';

export type SessionActivityState = 'idle' | 'running' | 'waiting_user_action';

/** Projection of facts owned by the adapter. Failures are query errors; an
 * idle/error runtime terminal is not evidence of successful completion. */
export function projectSessionActivity(state: SessionEngineLiveState): SessionActivityState {
  if (!state.isBusy && state.sessionState !== 'running' && state.sessionState !== 'starting') return 'idle';
  return state.waitingForUser ? 'waiting_user_action' : 'running';
}
