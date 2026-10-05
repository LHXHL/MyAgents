import { StrictMode, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBackgroundRequestFeedback } from "./useBackgroundRequestFeedback";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("automatic request feedback lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const onError = vi.fn();
    const hook = renderHook(
      ({ scope, enabled }) =>
        useBackgroundRequestFeedback(scope, enabled, onError),
      {
        initialProps: { scope: "account-A/space-A", enabled: true },
        wrapper: ({ children }: { children: ReactNode }) => (
          <StrictMode>{children}</StrictMode>
        ),
      },
    );
    const fail = async (at: number, key = "events") => {
      vi.setSystemTime(at);
      await act(async () => {
        await hook.result.current(key, async () => {
          throw new Error("offline");
        });
      });
    };
    return { ...hook, onError, fail };
  }

  it("notifies only sustained failures and resets on successful completion", async () => {
    const { result, onError, fail } = setup();
    await fail(0);
    await fail(15_000);
    expect(onError).not.toHaveBeenCalled();
    await fail(30_000);
    expect(onError).toHaveBeenCalledTimes(1);
    await act(async () => {
      expect(await result.current("events", async () => "ok")).toEqual({
        success: true,
        value: "ok",
      });
    });
    await fail(31_000);
    await fail(46_000);
    expect(onError).toHaveBeenCalledTimes(1);
    await fail(61_000);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("counts joined callers once without taking over API force semantics", async () => {
    const { result, onError, fail } = setup();
    await fail(0);
    const pending = deferred<void>();
    const request = vi.fn(() => pending.promise);
    vi.setSystemTime(30_000);
    const first = result.current("events", request);
    const second = result.current("events", request);
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => {
      pending.reject(new Error("offline"));
      await Promise.all([first, second]);
    });
    expect(onError).not.toHaveBeenCalled();
    await fail(45_000);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("drops older completions, including success that could erase a newer failure", async () => {
    const { result, onError, fail } = setup();
    await fail(0);
    const old = deferred<void>();
    const completion = result.current("events", () => old.promise);
    await fail(15_000);
    await act(async () => {
      old.resolve();
      await completion;
    });
    await fail(30_000);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("fences account/space switches and stale callbacks after A → B → A", async () => {
    const { result, rerender, onError, fail } = setup();
    await fail(0);
    await fail(15_000);
    const oldRun = result.current;
    const pending = deferred<void>();
    const completion = oldRun("events", () => pending.promise);
    rerender({ scope: "account-B/space-B", enabled: true });
    rerender({ scope: "account-A/space-A", enabled: true });
    vi.setSystemTime(30_000);
    await act(async () => {
      pending.reject(new Error("offline"));
      await completion;
    });
    const staleRequest = vi.fn().mockResolvedValue(undefined);
    await oldRun("events", staleRequest);
    expect(staleRequest).not.toHaveBeenCalled();
    await fail(30_000);
    await fail(45_000);
    expect(onError).not.toHaveBeenCalled();
    await fail(60_000);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("ignores hidden-page completions but retains an ongoing cooldown on re-entry", async () => {
    const { result, rerender, onError, fail } = setup();
    await fail(0);
    await fail(15_000);
    await fail(30_000);
    const pending = deferred<void>();
    const completion = result.current("events", () => pending.promise);
    rerender({ scope: "account-A/space-A", enabled: false });
    await act(async () => {
      pending.reject(new Error("offline"));
      await completion;
    });
    rerender({ scope: "account-A/space-A", enabled: true });
    await fail(60_000);
    expect(onError).toHaveBeenCalledTimes(1);
    await fail(330_000);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("does not notify after unmount or execute a retained callback", async () => {
    const { result, unmount, onError, fail } = setup();
    await fail(0);
    await fail(15_000);
    const run = result.current;
    const pending = deferred<void>();
    const completion = run("events", () => pending.promise);
    unmount();
    vi.setSystemTime(30_000);
    await act(async () => {
      pending.reject(new Error("offline"));
      await completion;
    });
    const request = vi.fn().mockResolvedValue(undefined);
    await run("events", request);
    expect(request).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
