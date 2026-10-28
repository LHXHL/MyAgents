import { readFileSync } from "node:fs";
import { channelFactsSchema, decorateChannelQuery } from "../../shared/channelContext";
import { renderSessionEventPrompt } from "../inbox/session-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  admitTaskNotification,
  taskNotificationContext,
} from "./task-notification";
import type { SessionEngine, InboxMessageRequest } from "./types";
import type { TaskResultEvent } from "../inbox/session-event";
const { management } = vi.hoisted(() => ({ management: vi.fn() }));
vi.mock("../utils/management-api-client", () => ({
  managementApi: management,
}));

const event: TaskResultEvent = {
  version: 1,
  type: "task.result",
  eventId: "attempt",
  attemptId: "attempt",
  taskId: "task",
  deliveryId: "delivery",
  targetSessionId: "A2",
  sourceSessionId: "B",
  conversation: { channelId: "feishu", sessionKey: "peer" },
  title: "Daily report",
  payload: "result",
  createdAt: "2026-10-25T00:00:00Z",
  statusOnly: false,
  sameSession: false,
};
function engine(run: SessionEngine["enqueueInboxMessage"]) {
  return {
    getCurrentSessionContext: () => ({ sessionId: "A2" }),
    enqueueInboxMessage: vi.fn(run),
    recordNotificationEvent: vi.fn(async () => {}),
  } as unknown as SessionEngine;
}
beforeEach(() => {
  vi.stubEnv("MYAGENTS_SIDECAR_ID", "A2");
  management.mockReset().mockResolvedValue({ ok: true, accepted: true });
});
afterEach(() => vi.unstubAllEnvs());
describe("Task result Session handoff", () => {
  it.each(["auto", "tool_only"] as const)("lets the destination Session follow its %s mode", mode => {
    const facts = channelFactsSchema.parse(JSON.parse(readFileSync(new URL("../../shared/__fixtures__/channel-context/p1.json", import.meta.url), "utf8")));
    facts.delivery.mode = mode;
    facts.delivery.ordinaryOutput = mode === "auto" ? "forwarded" : "not_forwarded";
    const prompt = decorateChannelQuery(renderSessionEventPrompt(event), { facts }, true);
    expect(prompt).toContain(mode === "auto" ? "当前处于自动回复模式" : "当前处于工具发送模式");
    expect(prompt).not.toContain("do not call IM sending tools");
    expect(prompt).toContain("decide whether and how");
  });

  it("ACKs queue ownership immediately and settles on dispatch acceptance, without waiting for a reply", async () => {
    let request!: InboxMessageRequest;
    let accept!: (value: { accepted: boolean }) => void;
    const target = engine(async input => {
      request = input;
      return { queued: true, dispatchAcceptance: new Promise(resolve => { accept = resolve; }) };
    });
    expect(await admitTaskNotification(target, event, "reminder", "/workspace")).toMatchObject({ queued: true });
    expect(management.mock.calls.filter(([path]) => path.endsWith("/terminal"))).toHaveLength(0);
    expect(request.queueId).toBe(event.attemptId);
    expect(request).not.toHaveProperty("inboxMeta");
    accept({ accepted: true });
    await vi.waitFor(() => expect(management).toHaveBeenCalledWith(
      "/api/task/notification/terminal", "POST",
      expect.objectContaining({ outcome: "handed-off", taskId: "task", deliveryId: "delivery", attemptId: "attempt" }),
    ));
  });
  it("does not start a second turn when the result is already in the destination Session", async () => {
    const target = engine(async () => { throw new Error("must not run"); });
    await admitTaskNotification(target, { ...event, sameSession: true }, "reminder", "/workspace");
    expect(target.enqueueInboxMessage).not.toHaveBeenCalled();
    expect(management).toHaveBeenLastCalledWith("/api/task/notification/terminal", "POST", expect.objectContaining({ outcome: "handed-off" }));
  });
  it("delivers status-only events to the ordinary Session input too", async () => {
    const target = engine(async () => ({ queued: true, dispatchAcceptance: Promise.resolve({ accepted: true }) }));
    await admitTaskNotification(target, { ...event, statusOnly: true }, "status reference", "/workspace");
    expect(target.enqueueInboxMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "status reference" }));
  });
  it("rechecks the binding at dispatch and retains a reroutable outcome", async () => {
    let request!: InboxMessageRequest;
    let accept!: (value: { accepted: boolean; error?: string }) => void;
    const target = engine(async input => { request = input; return { queued: true, dispatchAcceptance: new Promise(resolve => { accept = resolve; }) }; });
    await admitTaskNotification(target, event, "reminder", "/workspace");
    management.mockResolvedValueOnce({ ok: true, accepted: false, code: "binding_changed", error: "rotated" });
    expect((await request.beforeDispatch!()).accepted).toBe(false);
    accept({ accepted: false, error: "rotated" });
    await vi.waitFor(() => expect(management).toHaveBeenLastCalledWith("/api/task/notification/terminal", "POST", expect.objectContaining({ outcome: "binding_changed" })));
  });
  it("records admission failure rather than suppressing it or sending raw task output", async () => {
    const target = engine(async () => ({ queued: false, error: "provider unavailable" }));
    expect(await admitTaskNotification(target, event, "reminder", "/workspace")).toMatchObject({ error: "provider unavailable" });
    expect(management).toHaveBeenLastCalledWith("/api/task/notification/terminal", "POST", expect.objectContaining({ outcome: "failed", error: "provider unavailable" }));
    expect(management.mock.calls.at(-1)?.[2]).not.toHaveProperty("text");
  });
  it("keeps an offline target retryable without enqueueing", async () => {
    management.mockResolvedValueOnce({ ok: true, accepted: false, code: "offline", error: "Channel is restarting" });
    const target = engine(async () => { throw new Error("must not run"); });
    await admitTaskNotification(target, event, "reminder", "/workspace");
    expect(target.enqueueInboxMessage).not.toHaveBeenCalled();
    expect(management).toHaveBeenLastCalledWith("/api/task/notification/terminal", "POST", expect.objectContaining({ outcome: "offline" }));
  });
  it("does not retry when dispatch acceptance is unknown", async () => {
    const target = engine(async () => ({ queued: true, dispatchAcceptance: Promise.reject(new Error("connection lost")) }));
    await admitTaskNotification(target, event, "reminder", "/workspace");
    await vi.waitFor(() => expect(management).toHaveBeenLastCalledWith("/api/task/notification/terminal", "POST", expect.objectContaining({ outcome: "unknown" })));
    expect(target.enqueueInboxMessage).toHaveBeenCalledTimes(1);
  });
});

describe("Task notification source admission", () => {
  it("strips forged context for external/global callers and uses only the frozen internal turn", () => {
    const source = {
      getExecutionTurnId: vi.fn(() => "q1"),
      getCurrentTurnIdentity: vi.fn(() => ({
        owner: { kind: "task", id: "parent" },
      })),
      getNotificationConversation: vi.fn(() => ({
        channelId: "feishu",
        sessionKey: "group:one",
      })),
    } as unknown as SessionEngine;
    const forged = { notificationContext: { taskId: "forged" }, name: "child" };
    expect(
      taskNotificationContext(source, forged, { kind: "external-cli" }),
    ).toEqual({ name: "child" });
    expect(source.getExecutionTurnId).not.toHaveBeenCalled();
    expect(
      taskNotificationContext(source, forged, { kind: "internal" }),
    ).toMatchObject({
      notificationContext: {
        sidecarId: "A2",
        queueId: "q1",
        taskId: "parent",
        conversation: { channelId: "feishu", sessionKey: "group:one" },
      },
    });
    vi.mocked(source.getExecutionTurnId).mockReturnValue(null);
    expect(
      taskNotificationContext(source, forged, { kind: "internal" }),
    ).toEqual({ name: "child" });
  });
});
