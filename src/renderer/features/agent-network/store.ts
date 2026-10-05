import { useSyncExternalStore } from "react";
import { listenWithCleanup } from "@/utils/tauriListen";
import {
  networkSnapshot,
  setNetworkReadScope,
  type NetworkSnapshot,
} from "@/api/agentNetwork";

const initial: NetworkSnapshot = {
  state: "connecting",
  principalId: null,
  networkId: null,
  error: null,
  revision: 0,
  authGeneration: 0,
};
let snapshot = initial;
const listeners = new Set<() => void>();
// App-session drafts only, independently keyed for future network scopes.
const drafts = new Map<string, string>();
function accept(next: NetworkSnapshot) {
  if (next.revision < snapshot.revision) return;
  if (
    next.authGeneration !== snapshot.authGeneration ||
    next.state === "signedOut"
  )
    drafts.clear();
  snapshot = next;
  setNetworkReadScope(next);
  listeners.forEach((listener) => listener());
}
export function startAgentNetworkStore(): () => void {
  const abort = new AbortController();
  // Subscribe before reading: a committed auth boundary between these two
  // operations must be observed, and revision fencing handles late snapshots.
  void (async () => {
    const listener = await listenWithCleanup<NetworkSnapshot>(
      "agent-network:changed",
      (event) => accept(event.payload),
      abort.signal,
    );
    if (abort.signal.aborted) return;
    try {
      if (!listener.isRegistered())
        throw new Error("NETWORK_LISTENER_UNAVAILABLE");
      const value = await networkSnapshot();
      if (!abort.signal.aborted) accept(value);
    } catch {
      if (!abort.signal.aborted && snapshot === initial)
        accept({ ...initial, state: "unavailable" });
    }
  })();
  return () => {
    abort.abort();
    drafts.clear();
    snapshot = initial;
    setNetworkReadScope(null);
  };
}
export function useAgentNetworkSnapshot(): NetworkSnapshot {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    () => snapshot,
  );
}
export const currentNetworkGeneration = () => snapshot.authGeneration;
export function descriptionDraftKey(
  principalId: string,
  networkId: string,
  mountId: string,
): string {
  return JSON.stringify([principalId, networkId, mountId]);
}
export const getDescriptionDraft = (key: string): string | undefined =>
  drafts.get(key);
export function setDescriptionDraft(key: string, value: string) {
  drafts.set(key, value);
}
export function clearDescriptionDraft(key: string) {
  drafts.delete(key);
}
