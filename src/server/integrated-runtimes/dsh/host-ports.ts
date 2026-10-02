import {
  DSH_REVERSE_METHOD_NAMES,
  type DshHostRequestHandlers,
  type DshProtocolErrorConstructor,
  type DshRequestContext,
  type DshRpcObject,
  type DshRuntimeNotificationHandlers,
} from "./protocol-types";

type DshHostPortFence = Readonly<{
  productSessionId: string;
  runtimeGeneration: string;
  ProtocolError: DshProtocolErrorConstructor;
}>;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function protocolError(
  fence: DshHostPortFence,
  code: string,
  message: string,
  retryable = false,
): Error {
  return new fence.ProtocolError(code, message, retryable);
}

function assertReverseAuthority(
  params: DshRpcObject,
  fence: DshHostPortFence,
): number {
  const authority = object(params.authority);
  if (
    !authority ||
    authority.productSessionId !== fence.productSessionId ||
    authority.runtimeGeneration !== fence.runtimeGeneration
  ) {
    throw protocolError(
      fence,
      "host_authority_mismatch",
      "Reverse request authority does not match the active Runtime generation",
    );
  }
  const deadlineMs = authority.deadlineMs;
  if (
    typeof deadlineMs !== "number" ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > 600_000
  ) {
    throw protocolError(
      fence,
      "host_authority_invalid",
      "Reverse request deadline is invalid",
    );
  }
  return deadlineMs;
}

async function runBoundedHostHandler(
  handler: DshHostRequestHandlers[keyof DshHostRequestHandlers],
  params: DshRpcObject,
  context: DshRequestContext,
  deadlineMs: number,
  fence: DshHostPortFence,
): Promise<DshRpcObject> {
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort(context.signal.reason);
  if (context.signal.aborted) forwardAbort();
  else context.signal.addEventListener("abort", forwardAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deadlineMs);
  timer.unref?.();

  let rejectOnAbort: ((error: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = () => {
    rejectOnAbort?.(
      protocolError(
        fence,
        timedOut ? "host_reverse_timeout" : "host_reverse_cancelled",
        timedOut
          ? "Reverse Host request exceeded its declared deadline"
          : "Reverse Host request was cancelled",
        true,
      ),
    );
  };
  controller.signal.addEventListener("abort", onAbort, { once: true });

  const handlerPromise = Promise.resolve().then(() =>
    handler(params, {
      ...context,
      signal: controller.signal,
    }),
  );
  void handlerPromise.catch(() => undefined);
  try {
    if (controller.signal.aborted) onAbort();
    return await Promise.race([handlerPromise, aborted]);
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener("abort", forwardAbort);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

export function createFencedDshHostHandlers(
  handlers: DshHostRequestHandlers,
  fence: DshHostPortFence,
): DshHostRequestHandlers {
  const fenced = Object.fromEntries(
    DSH_REVERSE_METHOD_NAMES.map((method) => [
      method,
      async (params: DshRpcObject, context: DshRequestContext) => {
        const deadlineMs = assertReverseAuthority(params, fence);
        return await runBoundedHostHandler(
          handlers[method],
          params,
          context,
          deadlineMs,
          fence,
        );
      },
    ]),
  ) as DshHostRequestHandlers;
  return Object.freeze(fenced);
}

export function createFencedDshNotificationHandlers(
  handlers: DshRuntimeNotificationHandlers,
  fence: DshHostPortFence,
): DshRuntimeNotificationHandlers {
  return Object.freeze({
    "runtime/event": async (params) => {
      if (
        params.productSessionId !== fence.productSessionId ||
        params.runtimeGeneration !== fence.runtimeGeneration
      ) {
        throw protocolError(
          fence,
          "host_event_authority_mismatch",
          "Runtime event authority does not match the active generation",
        );
      }
      await handlers["runtime/event"](params);
    },
    "host/interaction/cancel": async (params) => {
      await handlers["host/interaction/cancel"](params);
    },
  });
}
