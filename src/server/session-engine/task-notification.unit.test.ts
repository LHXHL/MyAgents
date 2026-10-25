import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  admitTaskNotification,
  taskNotificationContext,
} from "./task-notification";
import type { SessionEngine, InjectedTurnRequest } from "./types";
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
function engine(
  run: (
    request: InjectedTurnRequest,
  ) => ReturnType<SessionEngine["runInjectedTurn"]>,
) {
  return {
    getCurrentSessionContext: () => ({ sessionId: "A2" }),
    runInjectedTurn: vi.fn(run),
    recordNotificationEvent: vi.fn(async () => {}),
  } as unknown as SessionEngine;
}
beforeEach(() => {
  vi.stubEnv("MYAGENTS_SIDECAR_ID", "A2");
  management.mockReset().mockResolvedValue({ ok: true, accepted: true });
});
afterEach(() => vi.unstubAllEnvs());
describe("Task result admission and terminal ownership", () => {
  it("ACKs a busy target queue before terminal, then commits only the exact turn text", async () => {
    let request!: InjectedTurnRequest;
    let complete!: (value: { success: boolean }) => void;
    const target = engine(async (input) => {
      request = input;
      input.onEnqueued?.("attempt");
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    expect(
      await admitTaskNotification(target, event, "host reminder", "/workspace"),
    ).toEqual({ queued: true });
    expect(
      management.mock.calls.filter(([path]) => path.endsWith("/terminal")),
    ).toHaveLength(0);
    expect(request.turnOwner).toBeUndefined();
    expect(request.assistantChannelDelivery).toBe("caller-owned");
    await request.onTerminal?.({
      status: "complete",
      text: "Explained result",
      assistantMessagePresent: true,
    });
    complete({ success: true });
    await Promise.resolve();
    expect(management).toHaveBeenCalledWith(
      "/api/task/notification/terminal",
      "POST",
      expect.objectContaining({
        taskId: "task",
        deliveryId: "delivery",
        attemptId: "attempt",
        outcome: "complete",
        text: "Explained result",
      }),
    );
  });
  it("uses existing output for B=A and records pure status without a model turn", async () => {
    const target = engine(async () => {
      throw new Error("must not run");
    });
    await admitTaskNotification(
      target,
      { ...event, sameSession: true },
      "reminder",
      "/workspace",
    );
    expect(target.runInjectedTurn).not.toHaveBeenCalled();
    expect(target.recordNotificationEvent).not.toHaveBeenCalled();
    await admitTaskNotification(
      target,
      { ...event, statusOnly: true },
      "status reference",
      "/workspace",
    );
    expect(target.recordNotificationEvent).toHaveBeenCalledWith(
      "task-notification-delivery",
      "status reference",
    );
    expect(target.runInjectedTurn).not.toHaveBeenCalled();
  });
  it("rechecks binding at promotion and returns a reroute receipt without rerunning the task", async () => {
    let request!: InjectedTurnRequest;
    const target = engine(async (input) => {
      request = input;
      input.onEnqueued?.("attempt");
      return new Promise(() => {});
    });
    await admitTaskNotification(target, event, "reminder", "/workspace");
    management.mockResolvedValueOnce({
      ok: true,
      accepted: false,
      code: "binding_changed",
      error: "rotated",
    });
    expect((await request.beforeDispatch!()).accepted).toBe(false);
    await request.onTerminal?.({
      status: "error",
      text: "",
      error: "rotated",
      assistantMessagePresent: false,
    });
    expect(management).toHaveBeenLastCalledWith(
      "/api/task/notification/terminal",
      "POST",
      expect.objectContaining({ outcome: "binding_changed" }),
    );
  });
  it("suppresses tool_only and does not fall back to raw text when preparation fails", async () => {
    const target = engine(async (input) => {
      await input.onTerminal?.({
        status: "error",
        text: "INTERNAL TOOL LOG",
        error: "provider unavailable",
        assistantMessagePresent: false,
      });
      return { success: false, error: "provider unavailable" };
    });
    await admitTaskNotification(target, event, "reminder", "/workspace");
    expect(management).toHaveBeenLastCalledWith(
      "/api/task/notification/terminal",
      "POST",
      expect.objectContaining({ outcome: "failed" }),
    );
    management.mockResolvedValueOnce({
      ok: true,
      accepted: false,
      code: "suppressed",
      error: "tool_only",
    });
    const suppressed = engine(async () => {
      throw new Error("must not run");
    });
    await admitTaskNotification(suppressed, event, "reminder", "/workspace");
    expect(suppressed.runInjectedTurn).not.toHaveBeenCalled();
    expect(management).toHaveBeenLastCalledWith(
      "/api/task/notification/terminal",
      "POST",
      expect.objectContaining({ outcome: "suppressed" }),
    );
  });
  it("keeps a temporarily offline promotion retryable at the same conversation", async () => {
    management.mockResolvedValueOnce({
      ok: true,
      accepted: false,
      code: "offline",
      error: "Channel is restarting",
    });
    const target = engine(async () => {
      throw new Error("must not run while offline");
    });
    await admitTaskNotification(target, event, "reminder", "/workspace");
    expect(target.runInjectedTurn).not.toHaveBeenCalled();
    expect(management).toHaveBeenLastCalledWith(
      "/api/task/notification/terminal",
      "POST",
      expect.objectContaining({
        outcome: "offline",
        deliveryId: event.deliveryId,
      }),
    );
    management.mockResolvedValue({ ok: true, accepted: true });
    await admitTaskNotification(
      target,
      { ...event, sameSession: true },
      "reminder",
      "/workspace",
    );
    expect(management).toHaveBeenLastCalledWith(
      "/api/task/notification/terminal",
      "POST",
      expect.objectContaining({ outcome: "complete", text: event.payload }),
    );
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
