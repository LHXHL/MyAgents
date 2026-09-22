import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancellableFetch: vi.fn(),
  getSessionMetadata: vi.fn(),
  getSessionData: vi.fn(),
}));

vi.mock("../utils/cancellation", () => ({
  cancellableFetch: mocks.cancellableFetch,
}));
vi.mock("../SessionStore", () => ({
  getSessionMetadata: mocks.getSessionMetadata,
  getSessionData: mocks.getSessionData,
}));

import { handleAdminInbox } from "./admin-handler";

describe("handleAdminInbox delivery acknowledgement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MYAGENTS_MANAGEMENT_PORT = "43123";
    mocks.getSessionMetadata.mockReturnValue({ agentDir: "/target/workspace" });
  });

  it("returns admission_unconfirmed with the request id on transport failure", async () => {
    mocks.cancellableFetch.mockRejectedValue(new Error("timeout"));

    const result = await handleAdminInbox(
      "",
      {
        toSessionId: "target-session",
        prompt: "Do the work",
        replyBack: true,
      },
      "external-cli",
    );

    expect(result).toMatchObject({
      status: 502,
      response: {
        delivered: false,
        unconfirmed: true,
        messageId: expect.any(String),
        error: { code: "admission_unconfirmed" },
      },
    });
    expect(mocks.cancellableFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/inbox/deliver"),
      expect.any(Object),
      { timeoutMs: 35_000 },
    );
  });

  it("does not turn an invalid management response into a definitive failure", async () => {
    mocks.cancellableFetch.mockResolvedValue(
      new Response("not-json", { status: 200 }),
    );

    const result = await handleAdminInbox(
      "",
      {
        toSessionId: "target-session",
        prompt: "Do the work",
        replyBack: false,
      },
      "external-cli",
    );

    expect(result.response).toMatchObject({
      unconfirmed: true,
      error: { code: "admission_unconfirmed" },
    });
  });

  it("does not turn an unknown management outcome into a definitive failure", async () => {
    mocks.cancellableFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, outcome: { status: "mystery" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await handleAdminInbox(
      "",
      { toSessionId: "target-session", prompt: "Do the work", replyBack: false },
      "external-cli",
    );

    expect(result.response).toMatchObject({
      unconfirmed: true,
      error: { code: "admission_unconfirmed" },
    });
  });

  it("does not confirm delivery when the admitted message id is missing", async () => {
    mocks.cancellableFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, outcome: { status: "delivered" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await handleAdminInbox(
      "",
      { toSessionId: "target-session", prompt: "Do the work", replyBack: false },
      "external-cli",
    );

    expect(result.response).toMatchObject({
      unconfirmed: true,
      error: { code: "admission_unconfirmed" },
    });
  });

  it("preserves an explicit target rejection and its reason", async () => {
    mocks.cancellableFetch.mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        outcome: { status: "rejected", reason: "runtime busy" },
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const result = await handleAdminInbox(
      "",
      { toSessionId: "target-session", prompt: "Do the work", replyBack: false },
      "external-cli",
    );

    expect(result).toMatchObject({
      status: 409,
      response: { error: { code: "rejected", message: "runtime busy" } },
    });
  });
});
