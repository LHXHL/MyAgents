import { afterEach, describe, expect, it, vi } from "vitest";
import type { NetworkSnapshot } from "@/api/agentNetwork";
const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), listen: vi.fn() }));
vi.mock("@/api/agentNetwork", () => ({
  networkSnapshot: mocks.snapshot,
  setNetworkReadScope: vi.fn(),
}));
vi.mock("@/utils/tauriListen", () => ({ listenWithCleanup: mocks.listen }));
import {
  startAgentNetworkStore,
  currentNetworkGeneration,
  descriptionDraftKey,
  setDescriptionDraft,
  getDescriptionDraft,
} from "./store";
const base: NetworkSnapshot = {
  state: "ready",
  principalId: "account",
  networkId: "network",
  error: null,
  revision: 1,
  authGeneration: 1,
};
let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.clearAllMocks();
});
describe("Agent network App projection", () => {
  it("subscribes before the initial read and fences a late old-account snapshot", async () => {
    let subscribe!: (value: { isRegistered: () => boolean }) => void;
    let resolve!: (value: NetworkSnapshot) => void;
    let event!: (event: { payload: NetworkSnapshot }) => void;
    mocks.listen.mockImplementation((_name, handler) => {
      event = handler;
      return new Promise((r) => {
        subscribe = r;
      });
    });
    mocks.snapshot.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    stop = startAgentNetworkStore();
    expect(mocks.snapshot).not.toHaveBeenCalled();
    subscribe({ isRegistered: () => true });
    await Promise.resolve();
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
    event({ payload: { ...base, revision: 3, authGeneration: 2 } });
    resolve(base);
    await Promise.resolve();
    await Promise.resolve();
    expect(currentNetworkGeneration()).toBe(2);
  });
  it("keeps drafts across metadata refresh but clears them at account boundaries", async () => {
    let event!: (event: { payload: NetworkSnapshot }) => void;
    mocks.listen.mockImplementation(async (_name, handler) => {
      event = handler;
      return { isRegistered: () => true };
    });
    mocks.snapshot.mockResolvedValue(base);
    stop = startAgentNetworkStore();
    await Promise.resolve();
    await Promise.resolve();
    const first = descriptionDraftKey("account", "network", "mount");
    const second = descriptionDraftKey("other-account", "network", "mount");
    setDescriptionDraft(first, "unsaved");
    expect(getDescriptionDraft(second)).toBeUndefined();
    event({ payload: { ...base, revision: 2 } });
    expect(getDescriptionDraft(first)).toBe("unsaved");
    event({
      payload: { ...base, state: "signedOut", revision: 3, authGeneration: 2 },
    });
    expect(getDescriptionDraft(first)).toBeUndefined();
  });
  it("does not issue an initial read if App teardown wins listener registration", async () => {
    let resolve!: (value: { isRegistered: () => boolean }) => void;
    mocks.listen.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    stop = startAgentNetworkStore();
    stop();
    resolve({ isRegistered: () => false });
    await Promise.resolve();
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
});
