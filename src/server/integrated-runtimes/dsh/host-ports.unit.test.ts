import { describe, expect, it, vi } from "vitest";

import {
  createFencedDshHostHandlers,
  createFencedDshNotificationHandlers,
} from "./host-ports";
import {
  DSH_REVERSE_METHOD_NAMES,
  type DshHostRequestHandlers,
  type DshRequestContext,
  type DshRpcObject,
  type DshRuntimeNotificationHandlers,
} from "./protocol-types";

class TestProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

const fence = {
  productSessionId: "product-session-1",
  runtimeGeneration: "generation-1",
  ProtocolError: TestProtocolError,
} as const;

function context(signal = new AbortController().signal): DshRequestContext {
  return {
    requestId: "r:1",
    signal,
    commit: vi.fn(),
    afterResponse: vi.fn(),
  };
}

function params(overrides: DshRpcObject = {}): DshRpcObject {
  return {
    authority: {
      requestId: "reverse-1",
      productSessionId: fence.productSessionId,
      runtimeGeneration: fence.runtimeGeneration,
      deadlineMs: 1_000,
    },
    ...overrides,
  };
}

function handlers(
  implementation: DshHostRequestHandlers[keyof DshHostRequestHandlers] = async () => ({
    ok: true,
  }),
): DshHostRequestHandlers {
  return Object.fromEntries(
    DSH_REVERSE_METHOD_NAMES.map((method) => [method, implementation]),
  ) as DshHostRequestHandlers;
}

describe("DSH reverse Host ports", () => {
  it("registers exactly seven fenced handlers", async () => {
    const implementation = vi.fn(async () => ({ ok: true }));
    const fenced = createFencedDshHostHandlers(handlers(implementation), fence);
    expect(Object.keys(fenced)).toEqual([...DSH_REVERSE_METHOD_NAMES]);
    await expect(
      fenced["host/tool/execute"](params(), context()),
    ).resolves.toEqual({ ok: true });
    expect(implementation).toHaveBeenCalledOnce();
  });

  it("rejects stale Product Session and Runtime generations", async () => {
    const fenced = createFencedDshHostHandlers(handlers(), fence);
    await expect(
      fenced["host/credential/resolve"](
        params({
          authority: {
            requestId: "reverse-1",
            productSessionId: "other-session",
            runtimeGeneration: "other-generation",
            deadlineMs: 1_000,
          },
        }),
        context(),
      ),
    ).rejects.toMatchObject({ code: "host_authority_mismatch" });
  });

  it("enforces the Runtime-declared deadline", async () => {
    const never = async () => await new Promise<DshRpcObject>(() => undefined);
    const fenced = createFencedDshHostHandlers(handlers(never), fence);
    await expect(
      fenced["host/hook/execute"](
        params({
          authority: {
            requestId: "reverse-1",
            productSessionId: fence.productSessionId,
            runtimeGeneration: fence.runtimeGeneration,
            deadlineMs: 5,
          },
        }),
        context(),
      ),
    ).rejects.toMatchObject({ code: "host_reverse_timeout", retryable: true });
  });

  it("fences Runtime events before projection", async () => {
    const projected = vi.fn();
    const notifications: DshRuntimeNotificationHandlers = {
      "runtime/event": projected,
      "host/interaction/cancel": vi.fn(),
    };
    const fenced = createFencedDshNotificationHandlers(notifications, fence);
    await fenced["runtime/event"]({
      productSessionId: fence.productSessionId,
      runtimeGeneration: fence.runtimeGeneration,
    });
    expect(projected).toHaveBeenCalledOnce();
    await expect(
      fenced["runtime/event"]({
        productSessionId: fence.productSessionId,
        runtimeGeneration: "stale-generation",
      }),
    ).rejects.toMatchObject({ code: "host_event_authority_mismatch" });
  });
});
