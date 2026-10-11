import React, { memo, useLayoutEffect } from "react";
import { act, render, cleanup, waitFor } from "@testing-library/react";
import { it, expect, vi, afterEach } from "vitest";
import TabProvider from "@/context/TabProvider";
import { useTabState, useTabApi } from "@/context/TabContext";
import {
  initFrontendLogger,
  restoreFrontendLogger,
  clearFrontendLogs,
  snapshotFrontendLogs,
  setFocusedTabId,
} from "@/utils/frontendLogger";
import type {
  SseEventHandler,
  SseConnectionStatusHandler,
} from "@/api/SseConnection";
type NativeListener = (event: { payload: unknown }) => void;
type Connection = {
  connected: boolean;
  event?: SseEventHandler;
  status?: SseConnectionStatusHandler;
};
const h = vi.hoisted(() => ({
  listeners: new Map<string, Set<NativeListener>>(),
  sse: new Map<string, Connection>(),
  invoke: vi.fn(async () => ({})),
  counts: Array<number>(12).fill(0),
  apiCounts: Array<number>(12).fill(0),
}));
vi.mock("@/api/SseConnection", () => ({
  createSseConnection: (id: string) => {
    const state: Connection = { connected: false };
    h.sse.set(id, state);
    return {
      setEventHandler: (f: SseEventHandler) => (state.event = f),
      setStatusHandler: (f: SseConnectionStatusHandler) => (state.status = f),
      connect: async () => {
        state.connected = true;
        state.status?.("connected");
      },
      disconnect: async () => {
        state.connected = false;
      },
      isActive: () => !!state.connected,
      getConnectionGeneration: () => 1,
    };
  },
}));
vi.mock("@/config/useConfigData", () => ({
  useConfigData: () => ({ config: {} }),
}));
vi.mock("@/config/services/agentConfigService", () => ({
  getProjectAgent: () => undefined,
}));
vi.mock("@/config/services/appConfigService", () => ({
  notifyConfigChanged: vi.fn(),
}));
vi.mock("@/analytics", () => ({
  track: vi.fn(),
  consumePendingSessionBirth: () => null,
  peekPendingSessionBirth: () => null,
  setPendingSessionBirth: vi.fn(),
  hashAgentNameSync: () => null,
  birthContextForSurface: () => ({}),
}));
vi.mock("@/api/tauriClient", () => ({
  getTabServerUrl: async () => "",
  sessionSidecarFetch: async () =>
    new Response(JSON.stringify({ success: true })),
  isTauri: () => true,
  getSessionActivation: async () => null,
  getSessionPort: async () => null,
  ensureSessionSidecar: async () => undefined,
  resetTabServerUrlCache: vi.fn(),
  setActiveCorrelation: vi.fn(),
  setFocusedCorrelationTabId: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@/utils/browserMock", () => ({ isTauriEnvironment: () => true }));
vi.mock("@/utils/tauriListen", () => ({
  listenWithCleanup: async (
    name: string,
    fn: NativeListener,
    signal: AbortSignal,
  ) => {
    const set = h.listeners.get(name) ?? new Set();
    h.listeners.set(name, set);
    set.add(fn);
    signal?.addEventListener("abort", () => set.delete(fn), { once: true });
    return { unlisten: () => set.delete(fn), isRegistered: () => set.has(fn) };
  },
}));
const Probe = memo(function Probe({ id }: { id: number }) {
  useTabState();
  useLayoutEffect(() => {
    h.counts[id]++;
  });
  return null;
});
const ApiProbe = memo(function ApiProbe({ id }: { id: number }) {
  useTabApi();
  useLayoutEffect(() => {
    h.apiCounts[id]++;
  });
  return null;
});
const claim = () => () => {};
async function mountTabs() {
  render(
    <>
      {Array.from({ length: 12 }, (_, id) => (
        <TabProvider
          key={id}
          tabId={"t" + id}
          sessionId={"pending-t" + id}
          agentDir="/tmp/audit-workspace"
          isActive={id === 0}
          claimSessionOpeningTransition={claim}
        >
          <Probe id={id} />
          <ApiProbe id={id} />
        </TabProvider>
      ))}
    </>,
  );
  await waitFor(() => expect(h.sse.size).toBe(12));
  await act(async () => {});
  h.counts.fill(0);
  h.apiCounts.fill(0);
}
function emit(id: number, event: string, data: unknown) {
  h.sse.get("t" + id)!.event!(event, data, { connectionGeneration: 1 });
}
afterEach(() => {
  restoreFrontendLogger();
  clearFrontendLogs();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  h.listeners.clear();
  h.sse.clear();
  h.invoke.mockClear();
});
it("keeps 12 Chat state consumers quiet for Rust, Node and React diagnostics", async () => {
  initFrontendLogger();
  initFrontendLogger();
  await mountTabs();
  setFocusedTabId("t0");
  expect(h.listeners.get("log:rust")?.size).toBe(1);
  clearFrontendLogs();
  h.counts.fill(0);
  h.apiCounts.fill(0);
  for (let i = 0; i < 20; i++)
    act(() => {
      for (const f of h.listeners.get("log:rust")!)
        f({
          payload: {
            source: "rust",
            level: "info",
            message: "synthetic-rust",
            timestamp: "2026-10-11T00:00:00Z",
            sessionId: "pending-t0",
            tabId: "t0",
          },
        });
      emit(0, "chat:log", {
        source: "bun",
        level: "info",
        message: "synthetic-node",
        timestamp: "2026-10-11T00:00:00Z",
      });
      console.log("synthetic-react");
    });
  expect(h.counts).toEqual(Array(12).fill(0));
  expect(h.apiCounts).toEqual(Array(12).fill(0));
  const logs = snapshotFrontendLogs({ tabId: "t0", sessionId: "pending-t0" });
  expect(logs.filter((log) => log.source === "rust")).toHaveLength(20);
  expect(logs.filter((log) => log.source === "bun")).toHaveLength(20);
  expect(logs.filter((log) => log.source === "react")).toHaveLength(20);
  expect(
    snapshotFrontendLogs({ tabId: "t1", sessionId: "pending-t1" }),
  ).toHaveLength(0);
  restoreFrontendLogger();
  expect(h.listeners.get("log:rust")?.size).toBe(0);
});
