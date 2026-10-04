import { describe, expect, it } from "vitest";
import { BackgroundFailureFeedback } from "./backgroundFailureFeedback";

describe("background failure feedback", () => {
  it("requires both three failures and thirty seconds", () => {
    const policy = new BackgroundFailureFeedback();
    expect(policy.failed("events", 0)).toBe(false);
    expect(policy.failed("events", 1)).toBe(false);
    expect(policy.failed("events", 2)).toBe(false);
    expect(policy.failed("events", 29_999)).toBe(false);
    expect(policy.failed("events", 30_000)).toBe(true);
    const slow = new BackgroundFailureFeedback();
    expect(slow.failed("events", 0)).toBe(false);
    expect(slow.failed("events", 60_000)).toBe(false);
    expect(slow.failed("events", 120_000)).toBe(true);
  });

  it("limits an ongoing failure to one notice per five minutes", () => {
    const policy = new BackgroundFailureFeedback();
    policy.failed("events", 0);
    policy.failed("events", 15_000);
    expect(policy.failed("events", 30_000)).toBe(true);
    expect(policy.failed("events", 329_999)).toBe(false);
    expect(policy.failed("events", 330_000)).toBe(true);
  });

  it("resets both the streak and its notice cooldown after recovery", () => {
    const policy = new BackgroundFailureFeedback();
    policy.failed("events", 0);
    policy.failed("events", 15_000);
    expect(policy.failed("events", 30_000)).toBe(true);
    policy.succeeded("events");
    expect(policy.failed("events", 31_000)).toBe(false);
    expect(policy.failed("events", 46_000)).toBe(false);
    expect(policy.failed("events", 61_000)).toBe(true);
  });

  it("does not combine failures or recovery across different resources", () => {
    const policy = new BackgroundFailureFeedback();
    policy.failed("events", 0);
    policy.failed("events", 15_000);
    expect(policy.failed("skills", 30_000)).toBe(false);
    policy.succeeded("skills");
    expect(policy.failed("events", 30_000)).toBe(true);
  });
});
