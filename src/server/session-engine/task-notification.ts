import type { SessionEngine, InboxAdmissionResult } from "./types";
import type { TaskResultEvent } from "../inbox/session-event";
import { managementApi } from "../utils/management-api-client";

/** Admission is short-lived. The original controlled turn owns completion;
 * TaskStore receives its exact terminal, never the latest assistant/idle state. */
export async function admitTaskNotification(
  engine: SessionEngine,
  event: TaskResultEvent,
  prompt: string,
  workspacePath: string,
): Promise<InboxAdmissionResult> {
  const sidecarId = process.env.MYAGENTS_SIDECAR_ID;
  if (
    !sidecarId ||
    engine.getCurrentSessionContext().sessionId !== event.targetSessionId
  )
    return { queued: false, error: "Notification target Session mismatch" };
  const identity = {
    sidecarId,
    taskId: event.taskId,
    deliveryId: event.deliveryId,
    attemptId: event.attemptId,
  };
  let rejection: string | undefined;
  const guard = async () => {
    const response = await managementApi(
      "/api/task/notification/authorize",
      "POST",
      identity,
    );
    if (response.accepted === true && response.ok === true)
      return { accepted: true as const };
    rejection = typeof response.code === "string" ? response.code : "failed";
    return {
      accepted: false as const,
      code: rejection,
      error: String(response.error ?? "Notification no longer authorized"),
    };
  };
  const terminal = async (outcome: string, text?: string, error?: string) => {
    const response = await managementApi(
      "/api/task/notification/terminal",
      "POST",
      { ...identity, outcome, text, error },
    );
    if (response.ok !== true)
      console.warn(
        "[task-notification] terminal receipt not committed:",
        response.error,
      );
  };
  const accepted = await guard();
  if (!accepted.accepted) {
    await terminal(rejection ?? "failed", undefined, accepted.error);
    return { queued: false, error: accepted.error };
  }
  if (event.statusOnly || event.sameSession) {
    try {
      // Same-Session execution already has its transcript. Only status events
      // add a host record; neither path runs a self-directed model turn.
      if (event.statusOnly)
        await engine.recordNotificationEvent(
          `task-notification-${event.deliveryId}`,
          prompt,
        );
      const text = event.statusOnly
        ? `${event.title}\n${event.payload}`
        : event.payload;
      await terminal(
        text.trim() ? "complete" : "failed",
        text,
        text.trim() ? undefined : "Task returned no usable text",
      );
      return { queued: false };
    } catch (error) {
      await terminal("failed", undefined, String(error));
      return { queued: false, error: String(error) };
    }
  }
  let admitted!: (result: InboxAdmissionResult) => void;
  const admission = new Promise<InboxAdmissionResult>((resolve) => {
    admitted = resolve;
  });
  let terminalObserved = false;
  const completion = engine
    .runInjectedTurn({
      prompt,
      sessionId: event.targetSessionId,
      workspacePath,
      scenario: { type: "desktop" },
      queueId: event.attemptId,
      assistantChannelDelivery: "caller-owned",
      timeoutMs: 300_000,
      analyticsOrigin: { kind: "automation", surface: "task_notification" },
      beforeDispatch: guard,
      onEnqueued: () => {
        admitted({ queued: true });
      },
      onTerminal: async (result) => {
        terminalObserved = true;
        const outcome =
          rejection ??
          (result.channelDeliveryMode === "tool_only"
            ? "suppressed"
            : result.status === "complete" && result.text.trim()
              ? "complete"
              : "failed");
        await terminal(outcome, result.text, result.error);
      },
    })
    .then(async (result) => {
      if (!terminalObserved)
        await terminal(
          rejection ?? (result.terminationUnconfirmed ? "unknown" : "failed"),
          undefined,
          result.error ??
            "Notification preparation did not produce a terminal result",
        );
      return {
        queued: false,
        ...(result.success
          ? {}
          : { error: result.error ?? "Notification preparation failed" }),
      };
    })
    .catch(async (error) => {
      if (!terminalObserved)
        await terminal("unknown", undefined, String(error));
      return { queued: false, error: String(error) };
    });
  // Promise keeps its terminal observer after the HTTP admission returns.
  return Promise.race([admission, completion]);
}

/** Only admission-owned context may select a default recipient. Never retain
 * caller-supplied provenance, including on an otherwise authorized public CLI. */
export function taskNotificationContext(
  engine: SessionEngine,
  payload: Record<string, unknown>,
  caller: { kind: string },
): Record<string, unknown> {
  const result = { ...payload };
  delete result.notificationContext;
  const sidecarId = process.env.MYAGENTS_SIDECAR_ID;
  if (caller.kind === "external-cli" || !sidecarId) return result;
  const queueId = engine.getExecutionTurnId();
  if (!queueId) return result;
  const turn = engine.getCurrentTurnIdentity();
  result.notificationContext = {
    sidecarId,
    queueId,
    conversation: engine.getNotificationConversation(),
    ...(turn?.owner.kind === "task" ? { taskId: turn.owner.id } : {}),
  };
  return result;
}
