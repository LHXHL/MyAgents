import { describe, expect, it, vi } from "vitest";

import { parseLeadingSystemReminder } from "../../shared/systemReminder";
import { createGoalOrchestrator } from "./goal-orchestrator";
import {
  cancelPendingGoalDispatches,
  getGoalTurnAuthority,
} from "./goal-turn-authority";
import type {
  BackgroundMessageRequest,
  DesktopMessageRequest,
  ImMessageRequest,
} from "./types";

function goal(overrides: Record<string, unknown> = {}) {
  return {
    id: "goal-1",
    objective: "Ship the complete feature",
    status: "active",
    turnCount: 2,
    revision: 7,
    controlRevision: 3,
    aiCanExit: true,
    sessionId: "session-1",
    workspacePath: "/workspace",
    ...overrides,
  };
}

function reservation(id: unknown, revision = 7, turnNumber = 3) {
  return { id, goalId: "goal-1", revision, turnNumber };
}

function claimedAdmission(goalValue: unknown, id: unknown, revision = 7, turnNumber = 3) {
  return {
    ok: true,
    goal: goalValue,
    reservation: reservation(id, revision, turnNumber),
  };
}

function claimedSchedulerTurn(leaseId: string, overrides: Record<string, unknown> = {}) {
  const claimedGoal = goal({ revision: 8, turnCount: 2, ...overrides });
  return {
    ok: true,
    goal: claimedGoal,
    lease: reservation(leaseId, 8, 3),
  };
}

function desktopRequest(text = "Please also run lint"): DesktopMessageRequest {
  return {
    text,
    sessionId: "session-1",
    workspacePath: "/workspace",
    scenario: { type: "desktop" },
  };
}

function imRequest(message = "Please also run lint"): ImMessageRequest {
  return {
    message,
    requestId: "request-1",
    sessionId: "session-1",
    workspacePath: "/workspace",
    scenario: {
      type: "agent-channel",
      platform: "feishu",
      sourceType: "private",
    },
    metadata: { source: "feishu_private", sourceId: "chat-1" },
  };
}

function managementClient(goalValue: unknown = goal()) {
  let currentGoal = goalValue;
  return vi.fn(
    async (
      path: string,
      _method: "GET" | "POST" = "GET",
      body?: Record<string, unknown>,
    ) => {
      if (path.startsWith("/api/goal/get?"))
        return { ok: true, goal: currentGoal };
      if (path === "/api/goal/objective") {
        if (currentGoal && typeof currentGoal === "object") {
          const record = currentGoal as Record<string, unknown>;
          currentGoal = {
            ...record,
            objective: body?.objective,
            revision: Number(record.revision ?? 0) + 1,
          };
        }
        return { ok: true, goal: currentGoal };
      }
      if (path === "/api/goal/admit") {
        if (currentGoal && typeof currentGoal === "object") {
          const record = currentGoal as Record<string, unknown>;
          currentGoal = {
            ...record,
            revision: Number(record.revision ?? 0) + 1,
          };
        }
        const revision = Number((currentGoal as Record<string, unknown>)?.revision ?? 0);
        return {
          ok: true,
          goal: currentGoal,
          reservation: reservation(body?.admissionId, revision),
        };
      }
      if (path === "/api/goal/admit/claim") {
        const revision = Number((currentGoal as Record<string, unknown>)?.revision ?? 0);
        return claimedAdmission(currentGoal, body?.admissionId, revision);
      }
      if (path === "/api/goal/admit/finalize")
        return { ok: true, goal: currentGoal };
      if (path === "/api/goal/admit/release")
        return { ok: true, goal: currentGoal };
      return { ok: false, error: `unexpected path ${path}` };
    },
  );
}

function turnLifecycle() {
  return {
    stopTurn: vi.fn(async () => ({ success: true })),
    waitIdle: vi.fn(async () => true),
  };
}

describe("Goal session orchestration", () => {
  it("wraps desktop input and commits admission only after adapter acceptance", async () => {
    const client = managementClient(goal({ aiCanExit: false }));
    const sendDesktopMessage = vi.fn(async (request: DesktopMessageRequest) => {
      await expect(request.beforeDispatch?.()).resolves.toMatchObject({
        accepted: true,
      });
      const parsed = parseLeadingSystemReminder(request.text);
      expect(parsed.kind).toBe("GOAL_CONTEXT");
      expect(parsed.visibleText).toBe("Please also run lint");
      expect(parsed.body).toContain("disabled autonomous Goal termination");
      expect(parsed.body).not.toContain("myagents goal update --status");
      return { success: true, queued: true };
    });

    const result = await createGoalOrchestrator(client).sendDesktopMessage(
      { sendDesktopMessage, ...turnLifecycle() },
      desktopRequest(),
    );

    expect(result.success).toBe(true);
    expect(client.mock.calls.map((call) => call[0])).toEqual([
      expect.stringMatching(/^\/api\/goal\/get\?/),
      "/api/goal/admit",
      "/api/goal/admit/claim",
      "/api/goal/admit/finalize",
      "/api/goal/admit/release",
    ]);
    expect(client.mock.calls[1]?.[2]).toEqual({
      sessionId: "session-1",
      workspacePath: "/workspace",
      goalId: "goal-1",
      expectedRevision: 7,
      expectedObjective: "Ship the complete feature",
      expectedControlRevision: 3,
      admissionId: expect.any(String),
      admissionKind: "user_query",
    });
  });

  it("does not admit a Goal when desktop admission is rejected", async () => {
    const client = managementClient();
    const sendDesktopMessage = vi.fn(async () => ({
      success: false,
      error: "queue full",
      status: 429,
    }));

    await createGoalOrchestrator(client).sendDesktopMessage(
      { sendDesktopMessage, ...turnLifecycle() },
      desktopRequest(),
    );

    expect(client.mock.calls.map((call) => call[0])).toEqual([
      expect.stringMatching(/^\/api\/goal\/get\?/),
      "/api/goal/admit",
      "/api/goal/admit/finalize",
    ]);
    expect(client.mock.calls[2]?.[2]).toMatchObject({ outcome: "aborted" });
  });

  it("retains turn authority and retries a transient admission release failure", async () => {
    let admissionId = "";
    let releaseCalls = 0;
    let resolveRelease!: (value: { ok: true; goal: unknown }) => void;
    const secondRelease = new Promise<{ ok: true; goal: unknown }>((resolve) => {
      resolveRelease = resolve;
    });
    const client = vi.fn(
      async (
        path: string,
        _method?: string,
        body?: Record<string, unknown>,
      ) => {
        if (path.startsWith("/api/goal/get?")) return { ok: true, goal: goal() };
        if (path === "/api/goal/admit") {
          admissionId = String(body?.admissionId ?? "");
          return {
            ok: true,
            goal: goal({ revision: 8 }),
            reservation: reservation(admissionId, 8),
          };
        }
        if (path === "/api/goal/admit/claim")
          return claimedAdmission(goal({ revision: 8 }), body?.admissionId, 8);
        if (path === "/api/goal/admit/finalize")
          return { ok: true, goal: goal() };
        if (path === "/api/goal/admit/release") {
          releaseCalls += 1;
          if (releaseCalls === 1)
            return { ok: false, error: "temporary management failure" };
          return secondRelease;
        }
        return { ok: false, error: `unexpected path ${path}` };
      },
    );
    const sendDesktopMessage = vi.fn(async (request: DesktopMessageRequest) => {
      await expect(request.beforeDispatch?.()).resolves.toMatchObject({
        accepted: true,
      });
      return { success: true };
    });

    await createGoalOrchestrator(client).sendDesktopMessage(
      { sendDesktopMessage, ...turnLifecycle() },
      desktopRequest(),
    );

    await vi.waitFor(() => expect(releaseCalls).toBe(2));
    expect(getGoalTurnAuthority("session-1")).toMatchObject({
      admissionId,
    });
    resolveRelease({ ok: true, goal: goal() });
    await vi.waitFor(() =>
      expect(getGoalTurnAuthority("session-1")).toBeNull(),
    );
  });

  it("does not dispatch as ordinary chat when the Goal reservation conflicts", async () => {
    const client = vi.fn(async (path: string) => {
      if (path.startsWith("/api/goal/get?")) return { ok: true, goal: goal() };
      if (path === "/api/goal/admit") {
        return {
          ok: false,
          code: "lease_conflict",
          error: "Another user admission exists",
        };
      }
      return { ok: false, error: `unexpected path ${path}` };
    });
    const sendDesktopMessage = vi.fn();

    const result = await createGoalOrchestrator(client).sendDesktopMessage(
      { sendDesktopMessage, ...turnLifecycle() },
      desktopRequest(),
    );

    expect(result).toMatchObject({
      success: false,
      status: 409,
      error: "Another user admission exists",
    });
    expect(sendDesktopMessage).not.toHaveBeenCalled();
  });

  it("fails closed when authoritative Goal lookup fails", async () => {
    const client = vi.fn(async (path: string) => {
      if (path.startsWith("/api/goal/get?")) {
        return { ok: false, error: "Goal store is temporarily unavailable" };
      }
      return { ok: false, error: `unexpected path ${path}` };
    });
    const sendDesktopMessage = vi.fn();

    const result = await createGoalOrchestrator(client).sendDesktopMessage(
      { sendDesktopMessage, ...turnLifecycle() },
      desktopRequest(),
    );

    expect(result).toMatchObject({
      success: false,
      status: 503,
      error: "Goal store is temporarily unavailable",
    });
    expect(sendDesktopMessage).not.toHaveBeenCalled();
  });

  it("fails closed when authoritative Goal lookup returns a malformed Goal", async () => {
    const client = vi.fn(async (path: string) => {
      if (path.startsWith("/api/goal/get?")) {
        return {
          ok: true,
          goal: { id: "goal-1", status: "active" },
        };
      }
      return { ok: false, error: `unexpected path ${path}` };
    });
    const sendDesktopMessage = vi.fn();

    const result = await createGoalOrchestrator(client).sendDesktopMessage(
      { sendDesktopMessage, ...turnLifecycle() },
      desktopRequest(),
    );

    expect(result).toMatchObject({
      success: false,
      status: 503,
      error: "Management API returned an invalid Goal",
    });
    expect(sendDesktopMessage).not.toHaveBeenCalled();
  });

  it("fails closed for a malformed terminal Goal instead of dispatching ordinary chat", async () => {
    const client = vi.fn(async (path: string) => {
      if (path.startsWith("/api/goal/get?")) {
        return {
          ok: true,
          goal: { id: "goal-1", objective: "Ship", status: "complete" },
        };
      }
      return { ok: false, error: `unexpected path ${path}` };
    });
    const sendDesktopMessage = vi.fn();

    const result = await createGoalOrchestrator(client).sendDesktopMessage(
      { sendDesktopMessage, ...turnLifecycle() },
      desktopRequest(),
    );

    expect(result).toMatchObject({ success: false, status: 503 });
    expect(sendDesktopMessage).not.toHaveBeenCalled();
  });

  it("accepts an authoritative Goal whose Windows workspace separators are equivalent", async () => {
    const client = managementClient(goal({ workspacePath: "C:/Workspace/Agent" }));
    const sendDesktopMessage = vi.fn(async () => ({ success: true }));

    const result = await createGoalOrchestrator(client).sendDesktopMessage(
      { sendDesktopMessage, ...turnLifecycle() },
      { ...desktopRequest(), workspacePath: "C:\\Workspace\\Agent" },
    );

    expect(result.success).toBe(true);
    expect(sendDesktopMessage).toHaveBeenCalledOnce();
  });

  it("fails closed for IM when authoritative Goal lookup throws", async () => {
    const client = vi.fn(async () => {
      throw new Error("management connection reset");
    });
    const enqueueImMessage = vi.fn();

    const result = await createGoalOrchestrator(client).enqueueImMessage(
      { enqueueImMessage, ...turnLifecycle() },
      imRequest(),
    );

    expect(result).toMatchObject({
      success: false,
      status: 503,
      error: "management connection reset",
    });
    expect(enqueueImMessage).not.toHaveBeenCalled();
  });

  it("claims at actual promotion when a user query waits behind a claimed auto turn", async () => {
    const client = managementClient();
    let queuedRequest: DesktopMessageRequest | undefined;
    let resolveDispatch!: (value: { accepted: boolean }) => void;
    const dispatchAcceptance = new Promise<{ accepted: boolean }>((resolve) => {
      resolveDispatch = resolve;
    });
    const sendDesktopMessage = vi.fn(async (request: DesktopMessageRequest) => {
      queuedRequest = request;
      return {
        success: true,
        queued: true,
        queueId: "queued-user",
        dispatchAcceptance,
      };
    });

    const result = await createGoalOrchestrator(client).sendDesktopMessage(
      { sendDesktopMessage, ...turnLifecycle() },
      desktopRequest(),
    );

    expect(result).toMatchObject({
      success: true,
      queued: true,
      queueId: "queued-user",
    });
    expect(client.mock.calls.map((call) => call[0])).toEqual([
      expect.stringMatching(/^\/api\/goal\/get\?/),
      "/api/goal/admit",
    ]);

    await expect(queuedRequest?.beforeDispatch?.()).resolves.toMatchObject({
      accepted: true,
    });
    resolveDispatch({ accepted: true });
    await vi.waitFor(() =>
      expect(client.mock.calls.map((call) => call[0])).toContain(
        "/api/goal/admit/finalize",
      ),
    );
  });

  it("does not await dispatch acceptance for a non-Goal desktop message", async () => {
    const client = managementClient(null);
    let resolveDispatch!: (value: { accepted: boolean }) => void;
    const dispatchAcceptance = new Promise<{ accepted: boolean }>((resolve) => {
      resolveDispatch = resolve;
    });
    const sendDesktopMessage = vi.fn(async () => ({
      success: true,
      queued: true,
      dispatchAcceptance,
    }));

    const sendPromise = createGoalOrchestrator(client).sendDesktopMessage(
      { sendDesktopMessage, ...turnLifecycle() },
      desktopRequest(),
    );

    await expect(sendPromise).resolves.toEqual({ success: true, queued: true });
    expect(client).toHaveBeenCalledTimes(1);
    resolveDispatch({ accepted: true });
  });

  it("does not admit when external dispatch rejects after initial desktop acceptance", async () => {
    const client = managementClient();
    const sendDesktopMessage = vi.fn(async (request: DesktopMessageRequest) => {
      await request.beforeDispatch?.();
      return {
        success: true,
        queued: true,
        dispatchAcceptance: Promise.resolve({
          accepted: false,
          error: "runtime rejected",
        }),
      };
    });

    const result = await createGoalOrchestrator(client).sendDesktopMessage(
      { sendDesktopMessage, ...turnLifecycle() },
      desktopRequest(),
    );

    expect(result).toEqual({ success: true, queued: true });
    await vi.waitFor(() => expect(client).toHaveBeenCalledTimes(4));
    expect(client.mock.calls[3]?.[2]).toMatchObject({ outcome: "aborted" });
  });

  it("aborts an IM admission when dispatch acknowledgement rejects", async () => {
    const client = managementClient();
    let resolveIdle!: (value: boolean) => void;
    const idleGate = new Promise<boolean>((resolve) => {
      resolveIdle = resolve;
    });
    const lifecycle = turnLifecycle();
    lifecycle.waitIdle.mockReturnValue(idleGate);
    const enqueueImMessage = vi.fn(async (request: ImMessageRequest) => {
      await request.beforeDispatch?.();
      return {
        success: true,
        queued: true,
        dispatchAcceptance: Promise.reject(new Error("ack channel closed")),
      };
    });

    const result = await createGoalOrchestrator(client).enqueueImMessage(
      { enqueueImMessage, ...lifecycle },
      imRequest(),
    );

    expect(result).toEqual({ success: true, queued: true });
    const finalizeCalls = client.mock.calls.filter(
      (call) => call[0] === "/api/goal/admit/finalize",
    );
    expect(finalizeCalls).toHaveLength(1);
    expect(finalizeCalls[0]?.[2]).toMatchObject({ outcome: "aborted" });
    expect(lifecycle.stopTurn).toHaveBeenCalledOnce();
    expect(client.mock.calls.map((call) => call[0])).not.toContain(
      "/api/goal/admit/release",
    );
    expect(getGoalTurnAuthority("session-1")).toMatchObject({
      admissionId: expect.any(String),
    });

    resolveIdle(true);
    await vi.waitFor(() =>
      expect(client.mock.calls.map((call) => call[0])).toContain(
        "/api/goal/admit/release",
      ),
    );
    await vi.waitFor(() =>
      expect(getGoalTurnAuthority("session-1")).toBeNull(),
    );
  });

  it("keeps accepted authority until idle when stale finalization cannot stop the turn", async () => {
    let resolveIdle!: (value: boolean) => void;
    const idleGate = new Promise<boolean>((resolve) => {
      resolveIdle = resolve;
    });
    const client = vi.fn(
      async (
        path: string,
        _method?: string,
        body?: Record<string, unknown>,
      ) => {
        if (path.startsWith("/api/goal/get?")) return { ok: true, goal: goal() };
        if (path === "/api/goal/admit") {
          return {
            ok: true,
            goal: goal({ revision: 8 }),
            reservation: reservation(body?.admissionId, 8),
          };
        }
        if (path === "/api/goal/admit/claim") {
          return claimedAdmission(goal({ revision: 8 }), body?.admissionId, 8);
        }
        if (path === "/api/goal/admit/finalize") {
          return { ok: false, code: "goal_changed", error: "Goal became terminal" };
        }
        if (path === "/api/goal/admit/release") {
          return { ok: false, code: "stale_admission", error: "already gone" };
        }
        return { ok: false, error: `unexpected path ${path}` };
      },
    );
    const lifecycle = {
      stopTurn: vi.fn(async () => ({ success: false, error: "runtime unavailable" })),
      waitIdle: vi.fn(() => idleGate),
    };
    const sendDesktopMessage = vi.fn(async (request: DesktopMessageRequest) => {
      await request.beforeDispatch?.();
      return { success: true, queued: true };
    });

    await createGoalOrchestrator(client).sendDesktopMessage(
      { sendDesktopMessage, ...lifecycle },
      desktopRequest(),
    );

    expect(lifecycle.stopTurn).toHaveBeenCalledOnce();
    expect(getGoalTurnAuthority("session-1")).toMatchObject({
      admissionId: expect.any(String),
    });
    expect(client.mock.calls.map((call) => call[0])).not.toContain(
      "/api/goal/admit/release",
    );

    resolveIdle(true);
    await vi.waitFor(() =>
      expect(client.mock.calls.map((call) => call[0])).toContain(
        "/api/goal/admit/release",
      ),
    );
    await vi.waitFor(() =>
      expect(getGoalTurnAuthority("session-1")).toBeNull(),
    );
  });

  it("retains authority until aborted admission cleanup is durably released", async () => {
    let admissionId = "";
    let resolveRelease!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      resolveRelease = resolve;
    });
    const client = vi.fn(
      async (
        path: string,
        _method?: string,
        body?: Record<string, unknown>,
      ) => {
        if (path.startsWith("/api/goal/get?")) return { ok: true, goal: goal() };
        if (path === "/api/goal/admit") {
          admissionId = String(body?.admissionId ?? "");
          return {
            ok: true,
            goal: goal({ revision: 8 }),
            reservation: reservation(admissionId, 8),
          };
        }
        if (path === "/api/goal/admit/claim") {
          return claimedAdmission(goal({ revision: 8 }), body?.admissionId, 8);
        }
        if (path === "/api/goal/admit/finalize") {
          return { ok: false, error: "temporary finalize failure" };
        }
        if (path === "/api/goal/admit/release") {
          await releaseGate;
          return { ok: true, goal: goal() };
        }
        return { ok: false, error: `unexpected path ${path}` };
      },
    );
    const sendDesktopMessage = vi.fn(async (request: DesktopMessageRequest) => {
      await request.beforeDispatch?.();
      return {
        success: true,
        queued: true,
        dispatchAcceptance: Promise.resolve({ accepted: false }),
      };
    });

    await createGoalOrchestrator(client).sendDesktopMessage(
      { sendDesktopMessage, ...turnLifecycle() },
      desktopRequest(),
    );
    await vi.waitFor(() =>
      expect(client.mock.calls.map((call) => call[0])).toContain(
        "/api/goal/admit/release",
      ),
    );
    expect(getGoalTurnAuthority("session-1")).toMatchObject({ admissionId });

    resolveRelease();
    await vi.waitFor(() =>
      expect(getGoalTurnAuthority("session-1")).toBeNull(),
    );
  });

  it("retries an idle check failure without dropping accepted admission authority", async () => {
    const client = managementClient();
    const lifecycle = turnLifecycle();
    lifecycle.waitIdle
      .mockRejectedValueOnce(new Error("runtime state unavailable"))
      .mockResolvedValueOnce(true);
    const sendDesktopMessage = vi.fn(async (request: DesktopMessageRequest) => {
      await request.beforeDispatch?.();
      return { success: true, queued: true };
    });

    await createGoalOrchestrator(client).sendDesktopMessage(
      { sendDesktopMessage, ...lifecycle },
      desktopRequest(),
    );

    await vi.waitFor(() => expect(lifecycle.waitIdle).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(client.mock.calls.map((call) => call[0])).toContain(
        "/api/goal/admit/release",
      ),
    );
    expect(getGoalTurnAuthority("session-1")).toBeNull();
  });

  it("does not reverse-finalize when accepted settlement itself fails", async () => {
    const outcomes: unknown[] = [];
    const client = vi.fn(
      async (
        path: string,
        _method?: string,
        body?: Record<string, unknown>,
      ) => {
        if (path.startsWith("/api/goal/get?")) return { ok: true, goal: goal() };
        if (path === "/api/goal/admit") {
          return {
            ok: true,
            goal: goal({ revision: 8 }),
            reservation: reservation(body?.admissionId, 8),
          };
        }
        if (path === "/api/goal/admit/claim") {
          return claimedAdmission(goal({ revision: 8 }), body?.admissionId, 8);
        }
        if (path === "/api/goal/admit/finalize") {
          outcomes.push(body?.outcome);
          throw new Error("finalize transport failed");
        }
        if (path === "/api/goal/admit/release") return { ok: true, goal: goal() };
        return { ok: false, error: `unexpected path ${path}` };
      },
    );
    const lifecycle = turnLifecycle();
    const sendDesktopMessage = vi.fn(async (request: DesktopMessageRequest) => {
      await request.beforeDispatch?.();
      return {
        success: true,
        queued: true,
        dispatchAcceptance: Promise.resolve({ accepted: true }),
      };
    });

    await createGoalOrchestrator(client).sendDesktopMessage(
      { sendDesktopMessage, ...lifecycle },
      desktopRequest(),
    );

    await vi.waitFor(() => expect(outcomes).toEqual(["accepted"]));
    expect(lifecycle.stopTurn).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(client.mock.calls.map((call) => call[0])).toContain(
        "/api/goal/admit/release",
      ),
    );
  });

  it("fails closed and releases when user claim returns malformed success", async () => {
    const client = vi.fn(
      async (
        path: string,
        _method?: string,
        body?: Record<string, unknown>,
      ) => {
        if (path.startsWith("/api/goal/get?")) return { ok: true, goal: goal() };
        if (path === "/api/goal/admit") {
          return {
            ok: true,
            goal: goal(),
            reservation: reservation(body?.admissionId),
          };
        }
        if (path === "/api/goal/admit/claim") return { ok: true };
        if (path === "/api/goal/admit/release") return { ok: true, goal: goal() };
        if (path === "/api/goal/admit/finalize") {
          return { ok: false, code: "stale_admission", error: "already released" };
        }
        return { ok: false, error: `unexpected path ${path}` };
      },
    );
    const runtimeDispatch = vi.fn();
    const sendDesktopMessage = vi.fn(async (request: DesktopMessageRequest) => {
      const guarded = await request.beforeDispatch?.();
      if (guarded?.accepted) runtimeDispatch();
      return guarded?.accepted
        ? { success: true, queued: true }
        : { success: false, error: guarded?.error };
    });

    const result = await createGoalOrchestrator(client).sendDesktopMessage(
      { sendDesktopMessage, ...turnLifecycle() },
      desktopRequest(),
    );

    expect(result.success).toBe(false);
    expect(runtimeDispatch).not.toHaveBeenCalled();
    expect(client.mock.calls.map((call) => call[0])).toContain(
      "/api/goal/admit/release",
    );
    expect(getGoalTurnAuthority("session-1")).toBeNull();
  });

  it("fails closed and releases when reservation revision disagrees with Goal", async () => {
    const client = vi.fn(async (path: string, _method?: string, body?: Record<string, unknown>) => {
      if (path.startsWith("/api/goal/get?")) return { ok: true, goal: goal() };
      if (path === "/api/goal/admit") {
        return {
          ok: true,
          goal: goal({ revision: 8 }),
          reservation: reservation(body?.admissionId, 7),
        };
      }
      if (path === "/api/goal/admit/release") return { ok: true, goal: goal() };
      return { ok: false, error: `unexpected path ${path}` };
    });
    const sendDesktopMessage = vi.fn();

    const result = await createGoalOrchestrator(client).sendDesktopMessage(
      { sendDesktopMessage, ...turnLifecycle() },
      desktopRequest(),
    );

    expect(result.success).toBe(false);
    expect(sendDesktopMessage).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(client.mock.calls.map((call) => call[0])).toContain("/api/goal/admit/release"),
    );
  });

  it("stops an accepted turn when finalize returns another Goal identity", async () => {
    const client = vi.fn(async (path: string, _method?: string, body?: Record<string, unknown>) => {
      if (path.startsWith("/api/goal/get?")) return { ok: true, goal: goal() };
      if (path === "/api/goal/admit") {
        return {
          ok: true,
          goal: goal({ revision: 8 }),
          reservation: reservation(body?.admissionId, 8),
        };
      }
      if (path === "/api/goal/admit/claim") {
        return claimedAdmission(goal({ revision: 8 }), body?.admissionId, 8);
      }
      if (path === "/api/goal/admit/finalize") {
        return { ok: true, goal: goal({ id: "other-goal" }) };
      }
      if (path === "/api/goal/admit/release") return { ok: true, goal: goal() };
      return { ok: false, error: `unexpected path ${path}` };
    });
    const lifecycle = turnLifecycle();
    const enqueueImMessage = vi.fn(async (request: ImMessageRequest) => {
      await request.beforeDispatch?.();
      return { success: true, queued: true };
    });

    await createGoalOrchestrator(client).enqueueImMessage(
      { enqueueImMessage, ...lifecycle },
      imRequest(),
    );

    expect(lifecycle.stopTurn).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(client.mock.calls.map((call) => call[0])).toContain("/api/goal/admit/release"),
    );
  });

  it("retries release after Stop wins a delayed user claim", async () => {
    let resolveClaim!: (value: Record<string, unknown>) => void;
    const claimGate = new Promise<Record<string, unknown>>((resolve) => {
      resolveClaim = resolve;
    });
    let releaseCalls = 0;
    const client = vi.fn(
      async (
        path: string,
        _method?: string,
        body?: Record<string, unknown>,
      ) => {
        if (path.startsWith("/api/goal/get?")) return { ok: true, goal: goal() };
        if (path === "/api/goal/admit") {
          return {
            ok: true,
            goal: goal(),
            reservation: reservation(body?.admissionId),
          };
        }
        if (path === "/api/goal/admit/claim") return claimGate;
        if (path === "/api/goal/admit/release") {
          releaseCalls += 1;
          return releaseCalls === 1
            ? { ok: false, error: "temporary release failure" }
            : { ok: true, goal: goal() };
        }
        if (path === "/api/goal/admit/finalize") {
          return { ok: false, code: "stale_admission", error: "already released" };
        }
        return { ok: false, error: `unexpected path ${path}` };
      },
    );
    const runtimeDispatch = vi.fn();
    const sendPromise = createGoalOrchestrator(client).sendDesktopMessage(
      {
        sendDesktopMessage: vi.fn(async (request: DesktopMessageRequest) => {
          const guarded = await request.beforeDispatch?.();
          if (guarded?.accepted) runtimeDispatch();
          return guarded?.accepted
            ? { success: true, queued: true }
            : { success: false, error: guarded?.error };
        }),
        ...turnLifecycle(),
      },
      desktopRequest(),
    );
    await vi.waitFor(() =>
      expect(client.mock.calls.map((call) => call[0])).toContain(
        "/api/goal/admit/claim",
      ),
    );

    cancelPendingGoalDispatches();
    const admissionId = client.mock.calls.find(
      (call) => call[0] === "/api/goal/admit",
    )?.[2]?.admissionId;
    resolveClaim(claimedAdmission(goal(), admissionId));

    await expect(sendPromise).resolves.toMatchObject({ success: false });
    await vi.waitFor(() => expect(releaseCalls).toBe(2));
    expect(runtimeDispatch).not.toHaveBeenCalled();
    expect(getGoalTurnAuthority("session-1")).toBeNull();
  });

  it("keeps slash commands untouched and skips Goal admission", async () => {
    const client = managementClient();
    const sendDesktopMessage = vi.fn(async (request: DesktopMessageRequest) => {
      expect(request.text).toBe("/model");
      return { success: true };
    });

    await createGoalOrchestrator(client).sendDesktopMessage(
      { sendDesktopMessage, ...turnLifecycle() },
      desktopRequest("/model"),
    );

    expect(client).not.toHaveBeenCalled();
  });

  it("wraps IM input without losing its request routing metadata", async () => {
    const client = managementClient(goal({ status: "paused" }));
    const enqueueImMessage = vi.fn(async (request: ImMessageRequest) => {
      await expect(request.beforeDispatch?.()).resolves.toMatchObject({
        accepted: true,
      });
      const parsed = parseLeadingSystemReminder(request.message);
      expect(parsed.visibleText).toBe("Please also run lint");
      expect(parsed.body).toContain("status: active");
      expect(request.requestId).toBe("request-1");
      expect(request.scenario.type).toBe("agent-channel");
      expect(request.metadata).toEqual({
        source: "feishu_private",
        sourceId: "chat-1",
      });
      return { success: true, queued: true };
    });

    await createGoalOrchestrator(client).enqueueImMessage(
      { enqueueImMessage, ...turnLifecycle() },
      imRequest(),
    );

    expect(client.mock.calls.map((call) => call[0])).toEqual([
      expect.stringMatching(/^\/api\/goal\/get\?/),
      "/api/goal/admit",
      "/api/goal/admit/claim",
      "/api/goal/admit/finalize",
      "/api/goal/admit/release",
    ]);
  });

  it("serializes concurrent Goal lookup and reservation without rejecting the second user query", async () => {
    let revision = 7;
    const reservations = new Map<
      string,
      { id: string; goalId: string; revision: number; turnNumber: number }
    >();
    const reserveRevisions: number[] = [];
    const currentGoal = () => goal({ revision });
    const client = vi.fn(
      async (
        path: string,
        _method?: string,
        body?: Record<string, unknown>,
      ) => {
        if (path.startsWith("/api/goal/get?")) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return { ok: true, goal: currentGoal() };
        }
        if (path === "/api/goal/admit") {
          const expectedRevision = Number(body?.expectedRevision);
          reserveRevisions.push(expectedRevision);
          if (expectedRevision !== revision) {
            return {
              ok: false,
              code: "stale_revision",
              error: "stale Goal revision",
              goal: currentGoal(),
            };
          }
          revision += 1;
          const reservation = {
            id: String(body?.admissionId),
            goalId: "goal-1",
            revision,
            turnNumber: reservations.size + 3,
          };
          reservations.set(reservation.id, reservation);
          return { ok: true, goal: currentGoal(), reservation };
        }
        if (path === "/api/goal/admit/claim") {
          revision += 1;
          return {
            ok: true,
            goal: currentGoal(),
            reservation: reservations.get(String(body?.admissionId)),
          };
        }
        if (
          path === "/api/goal/admit/finalize" ||
          path === "/api/goal/admit/release"
        ) {
          revision += 1;
          return { ok: true, goal: currentGoal() };
        }
        return { ok: false, error: `unexpected path ${path}` };
      },
    );
    const sendDesktopMessage = vi.fn(async (request: DesktopMessageRequest) => {
      const guarded = await request.beforeDispatch?.();
      return guarded?.accepted === false
        ? { success: false, error: guarded.error }
        : { success: true, queued: true };
    });
    const orchestrator = createGoalOrchestrator(client);

    const [first, second] = await Promise.all([
      orchestrator.sendDesktopMessage(
        { sendDesktopMessage, ...turnLifecycle() },
        desktopRequest("first queued query"),
      ),
      orchestrator.sendDesktopMessage(
        { sendDesktopMessage, ...turnLifecycle() },
        desktopRequest("second queued query"),
      ),
    ]);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(reserveRevisions).toHaveLength(2);
    expect(reserveRevisions[1]).toBeGreaterThan(reserveRevisions[0]);
  });
});

describe("Goal scheduler claim boundary", () => {
  it("waits for idle, then claims at the runtime dispatch boundary", async () => {
    const order: string[] = [];
    const client = vi.fn(
      async (
        path: string,
        _method?: string,
        body?: Record<string, unknown>,
      ) => {
        expect(path).toBe("/api/goal/scheduler/claim");
        expect(body).toEqual({
          sessionId: "session-1",
          workspacePath: "/workspace",
          goalId: "goal-1",
          leaseId: "lease-1",
          expectedRevision: 7,
        });
        order.push("claim");
        return claimedSchedulerTurn("lease-1");
      },
    );
    const engine = {
      waitIdle: vi.fn(async () => {
        order.push("idle");
        return true;
      }),
      getQueueStatus: vi.fn(() => []),
    };

    const result = await createGoalOrchestrator(client).runClaimedSchedulerTurn(
      engine,
      {
        sessionId: "session-1",
        workspacePath: "/workspace",
        goalId: "goal-1",
        leaseId: "lease-1",
        expectedRevision: 7,
        timeoutMs: 1_000,
        pollMs: 10,
      },
      async (beforeDispatch) => {
        order.push("prepare");
        expect(await beforeDispatch()).toEqual({ accepted: true });
        expect(getGoalTurnAuthority("session-1")).toMatchObject({
          leaseId: "lease-1",
        });
        order.push("run");
        return "completed";
      },
    );

    expect(result).toEqual({ success: true, value: "completed" });
    expect(order).toEqual(["idle", "prepare", "claim", "run"]);
    expect(getGoalTurnAuthority("session-1")).toBeNull();
  });

  it("does not dispatch when the scheduler lease became stale before claim", async () => {
    const client = vi.fn(async () => ({
      ok: false,
      code: "stale_lease",
      error: "Goal scheduler lease is stale",
    }));
    const runtimeDispatch = vi.fn(async () => "must not run");
    const run = vi.fn(
      async (
        beforeDispatch: import("../session-core/turn-queue").DispatchGuard,
      ) => {
        const guarded = await beforeDispatch();
        return guarded.accepted ? runtimeDispatch() : "guard rejected";
      },
    );

    const result = await createGoalOrchestrator(client).runClaimedSchedulerTurn(
      { waitIdle: vi.fn(async () => true), getQueueStatus: vi.fn(() => []) },
      {
        sessionId: "session-1",
        workspacePath: "/workspace",
        goalId: "goal-1",
        leaseId: "lease-stale",
        expectedRevision: 7,
        timeoutMs: 1_000,
      },
      run,
    );

    expect(result).toEqual({
      success: false,
      code: "stale_lease",
      error: "Goal scheduler lease is stale",
      status: 409,
    });
    expect(run).toHaveBeenCalledOnce();
    expect(runtimeDispatch).not.toHaveBeenCalled();
  });

  it("fails closed and revokes when scheduler claim returns malformed success", async () => {
    const client = vi.fn(async (path: string) => {
      if (path === "/api/goal/scheduler/claim") return { ok: true };
      if (path === "/api/goal/scheduler/revoke") return { ok: true };
      return { ok: false, error: `unexpected path ${path}` };
    });
    const runtimeDispatch = vi.fn();

    const result = await createGoalOrchestrator(client).runClaimedSchedulerTurn(
      { waitIdle: vi.fn(async () => true), getQueueStatus: vi.fn(() => []) },
      {
        sessionId: "session-1",
        workspacePath: "/workspace",
        goalId: "goal-1",
        leaseId: "lease-malformed",
        expectedRevision: 7,
        timeoutMs: 1_000,
      },
      async (beforeDispatch) => {
        const guarded = await beforeDispatch();
        if (guarded.accepted) runtimeDispatch();
        return guarded;
      },
    );

    expect(result).toMatchObject({
      success: false,
      code: "invalid_goal_payload",
      status: 502,
    });
    expect(client.mock.calls.map((call) => call[0])).toEqual([
      "/api/goal/scheduler/claim",
      "/api/goal/scheduler/revoke",
    ]);
    expect(runtimeDispatch).not.toHaveBeenCalled();
    expect(getGoalTurnAuthority("session-1")).toBeNull();
  });

  it("revokes a delayed successful claim when Stop cancels the pending guard", async () => {
    let resolveClaim!: (value: Record<string, unknown>) => void;
    const claimResponse = new Promise<Record<string, unknown>>((resolve) => {
      resolveClaim = resolve;
    });
    let revokeCalls = 0;
    const client = vi.fn(async (path: string) => {
      if (path === "/api/goal/scheduler/claim") return claimResponse;
      if (path === "/api/goal/scheduler/revoke") {
        revokeCalls += 1;
        if (revokeCalls === 1) {
          return { ok: false, error: "temporary revoke failure" };
        }
        return { ok: true, goal: goal({ status: "paused", revision: 8 }) };
      }
      return { ok: false, error: `unexpected path ${path}` };
    });
    const runtimeDispatch = vi.fn();
    const run = createGoalOrchestrator(client).runClaimedSchedulerTurn(
      { waitIdle: vi.fn(async () => true), getQueueStatus: vi.fn(() => []) },
      {
        sessionId: "session-1",
        workspacePath: "/workspace",
        goalId: "goal-1",
        leaseId: "lease-delayed",
        expectedRevision: 7,
        timeoutMs: 1_000,
      },
      async (beforeDispatch) => {
        const guarded = await beforeDispatch();
        if (guarded.accepted) runtimeDispatch();
        return guarded;
      },
    );
    await vi.waitFor(() =>
      expect(client).toHaveBeenCalledWith(
        "/api/goal/scheduler/claim",
        "POST",
        expect.any(Object),
      ),
    );

    cancelPendingGoalDispatches();
    resolveClaim(claimedSchedulerTurn("lease-delayed"));

    await expect(run).resolves.toMatchObject({
      success: false,
      code: "dispatch_canceled",
    });
    expect(client.mock.calls.map((call) => call[0])).toEqual([
      "/api/goal/scheduler/claim",
      "/api/goal/scheduler/revoke",
      "/api/goal/scheduler/revoke",
    ]);
    expect(runtimeDispatch).not.toHaveBeenCalled();
  });

  it("does not claim during the idle gap before an already queued user turn drains", async () => {
    const order: string[] = [];
    const client = vi.fn(async () => {
      order.push("claim");
      return claimedSchedulerTurn("lease-1");
    });
    const engine = {
      waitIdle: vi.fn(async () => {
        order.push("idle");
        return true;
      }),
      getQueueStatus: vi
        .fn()
        .mockReturnValueOnce([
          { id: "user-queued", messagePreview: "user turn" },
        ])
        .mockReturnValueOnce([]),
    };

    await createGoalOrchestrator(client).runClaimedSchedulerTurn(
      engine,
      {
        sessionId: "session-1",
        workspacePath: "/workspace",
        goalId: "goal-1",
        leaseId: "lease-1",
        expectedRevision: 7,
        timeoutMs: 1_000,
        pollMs: 1,
      },
      async (beforeDispatch) => {
        expect(await beforeDispatch()).toEqual({ accepted: true });
        order.push("run");
        return true;
      },
    );

    expect(order).toEqual(["idle", "idle", "claim", "run"]);
  });
});

describe("Goal objective updates", () => {
  const scenario: BackgroundMessageRequest["scenario"] = { type: "desktop" };

  function objectiveEngine(options: { busy: boolean }) {
    return {
      isBusy: vi.fn(() => options.busy),
      stopTurn: vi.fn(async () => ({ success: true })),
      waitIdle: vi.fn(async () => true),
      getQueueStatus: vi.fn<
        () => Array<{ id: string; messagePreview: string }>
      >(() => []),
      enqueueBackgroundMessage: vi.fn(
        async (request: BackgroundMessageRequest) => {
          const guarded = await request.beforeDispatch?.();
          return guarded?.accepted === false
            ? { success: false, error: guarded.error }
            : { success: true, queued: true };
        },
      ),
    };
  }

  it("fails closed with an unavailable status when the authoritative lookup fails", async () => {
    const client = vi.fn(async () => ({
      ok: false,
      code: "goal_store_unavailable",
      error: "Goal store is temporarily unavailable",
    }));
    const engine = objectiveEngine({ busy: false });

    const result = await createGoalOrchestrator(client).updateObjective(
      engine,
      {
        sessionId: "session-1",
        workspacePath: "/workspace",
        objective: "Updated",
        turnRequest: { scenario },
      },
    );

    expect(result).toEqual({
      success: false,
      error: "Goal store is temporarily unavailable",
      code: "goal_store_unavailable",
      status: 503,
    });
    expect(engine.stopTurn).not.toHaveBeenCalled();
    expect(engine.enqueueBackgroundMessage).not.toHaveBeenCalled();
  });

  it("persists only while paused", async () => {
    const client = managementClient(
      goal({ status: "paused", objective: "Updated" }),
    );
    const engine = objectiveEngine({ busy: true });

    const result = await createGoalOrchestrator(client).updateObjective(
      engine,
      {
        sessionId: "session-1",
        workspacePath: "/workspace",
        objective: "Updated",
        turnRequest: { scenario },
      },
    );

    expect(result.delivery).toBe("persisted");
    expect(engine.stopTurn).toHaveBeenCalledTimes(2);
    expect(engine.waitIdle).toHaveBeenCalledTimes(2);
    expect(engine.enqueueBackgroundMessage).not.toHaveBeenCalled();
  });

  it("preserves queued user messages by rejecting objective edits until the queue drains", async () => {
    const paused = goal({ status: "paused", objective: "Old", revision: 7 });
    const current = paused;
    const client = vi.fn(async (path: string) => {
      if (path.startsWith("/api/goal/get?")) return { ok: true, goal: current };
      return { ok: false, error: `unexpected path ${path}` };
    });
    const engine = objectiveEngine({ busy: false });
    engine.getQueueStatus.mockReturnValueOnce([
      { id: "stale-user", messagePreview: "old input" },
    ]);

    const result = await createGoalOrchestrator(client).updateObjective(
      engine,
      {
        sessionId: "session-1",
        workspacePath: "/workspace",
        objective: "Updated",
        turnRequest: { scenario },
      },
    );

    expect(result).toMatchObject({
      success: false,
      code: "queue_conflict",
      status: 409,
      goal: paused,
    });
    expect(client.mock.calls.map((call) => call[0])).toEqual([
      expect.stringMatching(/^\/api\/goal\/get\?/),
    ]);
    expect(engine.stopTurn).not.toHaveBeenCalled();
    expect(engine.waitIdle).not.toHaveBeenCalled();
  });

  it("serializes objective CAS against a concurrent user admission", async () => {
    const before = goal({ status: "paused", objective: "Old", revision: 7 });
    const updated = goal({
      status: "paused",
      objective: "Updated",
      revision: 8,
    });
    let current = before;
    let releaseObjective!: () => void;
    const objectiveGate = new Promise<void>((resolve) => {
      releaseObjective = resolve;
    });
    let objectiveStarted!: () => void;
    const objectiveEntered = new Promise<void>((resolve) => {
      objectiveStarted = resolve;
    });
    let getCount = 0;
    const client = vi.fn(
      async (
        path: string,
        _method?: string,
        body?: Record<string, unknown>,
      ) => {
        if (path.startsWith("/api/goal/get?")) {
          getCount += 1;
          return { ok: true, goal: current };
        }
        if (path === "/api/goal/objective") {
          objectiveStarted();
          await objectiveGate;
          current = updated;
          return { ok: true, goal: updated };
        }
        if (path === "/api/goal/admit") {
          return {
            ok: true,
            goal: current,
            reservation: reservation(body?.admissionId, updated.revision),
          };
        }
        if (path === "/api/goal/admit/claim") {
          return claimedAdmission(current, body?.admissionId, updated.revision);
        }
        if (path === "/api/goal/admit/finalize" || path === "/api/goal/admit/release") {
          return { ok: true, goal: current };
        }
        return { ok: false, error: `unexpected path ${path}` };
      },
    );
    const orchestrator = createGoalOrchestrator(client);
    const update = orchestrator.updateObjective(
      objectiveEngine({ busy: false }),
      {
        sessionId: "session-1",
        workspacePath: "/workspace",
        objective: "Updated",
        turnRequest: { scenario },
      },
    );
    await objectiveEntered;

    const send = orchestrator.sendDesktopMessage(
      {
        sendDesktopMessage: vi.fn(async (request: DesktopMessageRequest) => {
          const guarded = await request.beforeDispatch?.();
          return guarded?.accepted === false
            ? { success: false, error: guarded.error }
            : { success: true, queued: true };
        }),
        ...turnLifecycle(),
      },
      desktopRequest("query racing objective edit"),
    );
    await Promise.resolve();
    expect(getCount).toBe(2);

    releaseObjective();
    await expect(update).resolves.toMatchObject({ success: true, goal: updated });
    await expect(send).resolves.toMatchObject({ success: true });
    expect(getCount).toBe(4);
  });

  it("restarts instead of steering a turn claimed under the old objective", async () => {
    const client = managementClient(goal({ objective: "Updated" }));
    const engine = objectiveEngine({ busy: true });

    const result = await createGoalOrchestrator(client).updateObjective(
      engine,
      {
        sessionId: "session-1",
        workspacePath: "/workspace",
        objective: "Updated",
        turnRequest: { scenario },
      },
    );

    expect(result.delivery).toBe("restarted");
    const request = engine.enqueueBackgroundMessage.mock.calls[0]?.[0];
    expect(parseLeadingSystemReminder(request.text).kind).toBe(
      "GOAL_OBJECTIVE_UPDATED",
    );
    expect(engine.stopTurn).toHaveBeenCalledTimes(2);
    expect(client.mock.calls[2]?.[2]).toEqual({
      sessionId: "session-1",
      workspacePath: "/workspace",
      objective: "Updated",
      goalId: "goal-1",
      expectedRevision: 7,
    });
  });

  it("stops at an idle boundary and restarts under the new objective", async () => {
    const client = managementClient(
      goal({ objective: "Updated", aiCanExit: false }),
    );
    const engine = objectiveEngine({ busy: true });

    const result = await createGoalOrchestrator(client).updateObjective(
      engine,
      {
        sessionId: "session-1",
        workspacePath: "/workspace",
        objective: "Updated",
        turnRequest: { scenario },
      },
    );

    expect(result.delivery).toBe("restarted");
    expect(engine.stopTurn).toHaveBeenCalledTimes(2);
    expect(engine.waitIdle).toHaveBeenCalledAfter(engine.stopTurn);
    expect(engine.enqueueBackgroundMessage).toHaveBeenCalledAfter(
      engine.waitIdle,
    );
    const request = engine.enqueueBackgroundMessage.mock.calls[0]?.[0];
    expect(request.model).toBeUndefined();
    expect(request.permissionMode).toBeUndefined();
    expect(request.text).toContain("disabled autonomous Goal termination");
    expect(request.text).not.toContain("myagents goal update --status");
    expect(client.mock.calls.map((call) => call[0])).toContain(
      "/api/goal/admit/finalize",
    );
  });

  it("aborts an objective restart when dispatch acknowledgement rejects", async () => {
    const client = managementClient(goal({ objective: "Updated" }));
    const engine = objectiveEngine({ busy: true });
    engine.enqueueBackgroundMessage.mockImplementationOnce(
      async (request: BackgroundMessageRequest) => {
        await request.beforeDispatch?.();
        return {
          success: true,
          queued: true,
          dispatchAcceptance: Promise.reject(new Error("ack channel closed")),
        };
      },
    );

    const result = await createGoalOrchestrator(client).updateObjective(
      engine,
      {
        sessionId: "session-1",
        workspacePath: "/workspace",
        objective: "Updated",
        turnRequest: { scenario },
      },
    );

    expect(result).toMatchObject({
      success: false,
      status: 503,
      error: "ack channel closed",
    });
    const finalizeCalls = client.mock.calls.filter(
      (call) => call[0] === "/api/goal/admit/finalize",
    );
    expect(finalizeCalls).toHaveLength(1);
    expect(finalizeCalls[0]?.[2]).toMatchObject({ outcome: "aborted" });
    expect(engine.stopTurn).toHaveBeenCalledTimes(3);
    expect(getGoalTurnAuthority("session-1")).toBeNull();
  });

  it("rejects a restart when the Goal changes after the objective CAS", async () => {
    const before = goal({ objective: "Old", revision: 7 });
    const updated = goal({ objective: "Updated", revision: 8 });
    const stale = goal({ objective: "Updated again", revision: 9 });
    let getCount = 0;
    const client = vi.fn(async (path: string) => {
      if (path.startsWith("/api/goal/get?")) {
        getCount += 1;
        return { ok: true, goal: getCount < 3 ? before : stale };
      }
      if (path === "/api/goal/objective") return { ok: true, goal: updated };
      return { ok: false, error: `unexpected path ${path}` };
    });
    const engine = objectiveEngine({ busy: true });

    const result = await createGoalOrchestrator(client).updateObjective(
      engine,
      {
        sessionId: "session-1",
        workspacePath: "/workspace",
        objective: "Updated",
        turnRequest: { scenario },
      },
    );

    expect(result).toMatchObject({
      success: false,
      code: "goal_changed",
      status: 409,
    });
    expect(engine.stopTurn).toHaveBeenCalledTimes(2);
    expect(engine.enqueueBackgroundMessage).not.toHaveBeenCalled();
  });

  it("compensates and reports conflict when restart finalization becomes terminal", async () => {
    const before = goal({ objective: "Old", revision: 7 });
    const active = goal({ objective: "Updated", revision: 8 });
    const terminal = goal({
      objective: "Updated",
      revision: 9,
      status: "canceled",
    });
    let current = before;
    const client = vi.fn(
      async (
        path: string,
        _method?: string,
        body?: Record<string, unknown>,
      ) => {
        if (path.startsWith("/api/goal/get?"))
          return { ok: true, goal: current };
        if (path === "/api/goal/objective") {
          current = active;
          return { ok: true, goal: active };
        }
        if (path === "/api/goal/admit") {
          expect(body).toMatchObject({ admissionKind: "objective_restart" });
          return {
            ok: true,
            goal: active,
            reservation: reservation(body?.admissionId, 8),
          };
        }
        if (path === "/api/goal/admit/claim") {
          return claimedAdmission(active, body?.admissionId, 8);
        }
        if (path === "/api/goal/admit/finalize") {
          return {
            ok: false,
            code: "terminal",
            error: "Goal is terminal",
            goal: terminal,
          };
        }
        if (path === "/api/goal/admit/release") {
          return { ok: true, goal: terminal };
        }
        return { ok: false, error: `unexpected path ${path}` };
      },
    );
    const engine = objectiveEngine({ busy: true });

    const result = await createGoalOrchestrator(client).updateObjective(
      engine,
      {
        sessionId: "session-1",
        workspacePath: "/workspace",
        objective: "Updated",
        turnRequest: { scenario },
      },
    );

    expect(result).toMatchObject({
      success: false,
      code: "terminal",
      status: 409,
      goal: terminal,
    });
    expect(engine.enqueueBackgroundMessage).toHaveBeenCalledOnce();
    expect(engine.stopTurn).toHaveBeenCalledTimes(3);
    await vi.waitFor(() =>
      expect(client.mock.calls.map((call) => call[0])).toContain(
        "/api/goal/admit/release",
      ),
    );
  });

  it("does not duplicate a restart when the scheduler owns the updated revision", async () => {
    const before = goal({ objective: "Old", revision: 7 });
    const active = goal({ objective: "Updated", revision: 8 });
    let current = before;
    const client = vi.fn(
      async (
        path: string,
        _method?: string,
        body?: Record<string, unknown>,
      ) => {
        if (path.startsWith("/api/goal/get?"))
          return { ok: true, goal: current };
        if (path === "/api/goal/objective") {
          current = active;
          return { ok: true, goal: active };
        }
        if (path === "/api/goal/admit") {
          expect(body).toMatchObject({ admissionKind: "objective_restart" });
          return {
            ok: false,
            code: "lease_conflict",
            error: "Scheduler owns the next Goal turn",
            goal: active,
          };
        }
        return { ok: false, error: `unexpected path ${path}` };
      },
    );
    const engine = objectiveEngine({ busy: true });

    const result = await createGoalOrchestrator(client).updateObjective(
      engine,
      {
        sessionId: "session-1",
        workspacePath: "/workspace",
        objective: "Updated",
        turnRequest: { scenario },
      },
    );

    expect(result).toMatchObject({
      success: true,
      delivery: "persisted",
      goal: active,
    });
    expect(engine.enqueueBackgroundMessage).not.toHaveBeenCalled();
  });

  it("CASes against a newer same-objective revision observed after stopping", async () => {
    const before = goal({ objective: "Old", revision: 7 });
    const afterStop = goal({ objective: "Old", revision: 8 });
    const updated = goal({ objective: "Updated", revision: 9 });
    let getCount = 0;
    const client = vi.fn(
      async (
        path: string,
        _method?: string,
        body?: Record<string, unknown>,
      ) => {
        if (path.startsWith("/api/goal/get?")) {
          getCount += 1;
          return {
            ok: true,
            goal:
              getCount === 1 ? before : getCount === 2 ? afterStop : updated,
          };
        }
        if (path === "/api/goal/objective") {
          expect(body).toMatchObject({
            goalId: "goal-1",
            expectedRevision: 8,
            objective: "Updated",
          });
          return { ok: true, goal: updated };
        }
        if (path === "/api/goal/admit") {
          return {
            ok: true,
            goal: updated,
            reservation: reservation(body?.admissionId, 9),
          };
        }
        if (path === "/api/goal/admit/claim") {
          return claimedAdmission(updated, body?.admissionId, 9);
        }
        if (path === "/api/goal/admit/finalize")
          return { ok: true, goal: updated };
        if (path === "/api/goal/admit/release")
          return { ok: true, goal: updated };
        return { ok: false, error: `unexpected path ${path}` };
      },
    );
    const engine = objectiveEngine({ busy: true });

    const result = await createGoalOrchestrator(client).updateObjective(
      engine,
      {
        sessionId: "session-1",
        workspacePath: "/workspace",
        objective: "Updated",
        turnRequest: { scenario },
      },
    );

    expect(result).toMatchObject({
      success: true,
      delivery: "restarted",
      goal: updated,
    });
  });
});
