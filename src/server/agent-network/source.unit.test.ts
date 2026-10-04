import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentReference,
  sessionReference,
  REMOTE_DEADLINES,
} from "@myagents/agent-network-protocol";
import { networkRequest, networkOutcome, routeNetworkRequest } from "./source";

const { management } = vi.hoisted(() => ({ management: vi.fn() }));
vi.mock("../utils/management-api-client", () => ({
  managementApi: management,
}));
const ref = {
  serviceId: "00000000-0000-0000-0000-000000000001",
  networkId: "00000000-0000-0000-0000-000000000002",
  mountId: "00000000-0000-0000-0000-000000000003",
};
const agent = agentReference(ref);
const session = sessionReference({ ...ref, localSessionId: "legacy-session" });
describe("unified source routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MYAGENTS_SIDECAR_ID", "source-process");
  });
  it("leaves all local operations independent of the network", async () => {
    expect(
      await routeNetworkRequest(
        "session/start",
        { agentId: "local-agent", prompt: "work" },
        "internal-session",
      ),
    ).toBeNull();
    expect(management).not.toHaveBeenCalled();
    expect(networkRequest("agent/current", {}, "internal-session")).toBeNull();
  });
  it("rejects reserved malformed references, wrong target types and caller/config overrides before IO", async () => {
    for (const payload of [
      { agentId: "ma-agent:broken" },
      { agentId: session },
      { agentId: agent, runtime: "codex" },
      { agentId: agent, sourceSessionId: "impersonated" },
    ]) {
      expect(
        await routeNetworkRequest(
          "session/start",
          { prompt: "work", ...payload },
          "internal-session",
        ),
      ).toMatchObject({ success: false });
    }
    expect(management).not.toHaveBeenCalled();
  });
  it("keeps external CLI one way and defaults identical to the original read handlers", () => {
    expect(
      networkRequest(
        "session/start",
        { agentId: agent, prompt: "work", replyBack: true },
        "external-cli",
      )?.operation.params,
    ).toMatchObject({ replyBack: false });
    expect(() =>
      networkRequest(
        "session/watch",
        { targetSessionId: session },
        "external-cli",
      ),
    ).toThrow();
    expect(
      networkRequest("session/get", { sessionId: session }, "internal-session")
        ?.operation.params,
    ).toEqual({ limit: 5 });
  });
  it("projects actual receipts into reusable qualified references without inventing acceptance", () => {
    const req = networkRequest(
      "session/start",
      { agentId: agent, prompt: "work" },
      "internal-session",
    )!;
    const messageId = "00000000-0000-0000-0000-000000000004";
    expect(
      networkOutcome(req, {
        method: "session.start",
        result: {
          accepted: true,
          asynchronous: true,
          agentId: "target-local-agent",
          sessionId: "legacy-session",
          messageId,
        },
      }),
    ).toMatchObject({
      success: true,
      agentId: agent,
      sessionId: session,
      messageId,
    });
    expect(
      networkOutcome(req, {
        method: "session.start",
        result: { accepted: null, unconfirmed: true },
      }),
    ).toMatchObject({
      success: false,
      unconfirmed: true,
      code: "admission_unconfirmed",
    });
    expect(() =>
      networkOutcome(req, { method: "session.list", result: [] }),
    ).toThrow();
  });
  it("sends one Host-bound request with the shared budget and preserves transport uncertainty", async () => {
    management.mockResolvedValue({
      ok: false,
      code: "transport_outcome_unknown",
    });
    const result = await routeNetworkRequest(
      "session/send",
      { toSessionId: session, prompt: "continue" },
      "internal-session",
    );
    expect(result).toMatchObject({
      success: false,
      code: "admission_unconfirmed",
      unconfirmed: true,
      selector: session,
    });
    expect(management).toHaveBeenCalledTimes(1);
    expect(management.mock.calls[0]).toMatchObject([
      "/api/agent-network/invoke",
      "POST",
      { sidecarId: "source-process", sourceKind: "internal-session" },
      { timeoutMs: REMOTE_DEADLINES["session.send"].admin },
    ]);
  });
  it('read failures remain retryable query errors, never ambiguous execution admission', async () => {
    management.mockResolvedValue({ ok: false, code: 'ADMISSION_UNCONFIRMED' });
    expect(await routeNetworkRequest('session/state', { sessionId: session }, 'internal-session'))
      .toMatchObject({ success: false, code: 'NETWORK_QUERY_FAILED' });
    management.mockRejectedValue(new Error('connection lost'));
    const failed = await routeNetworkRequest('session/get', { sessionId: session }, 'internal-session');
    expect(failed).toMatchObject({ success: false, code: 'NETWORK_QUERY_FAILED' });
    expect(failed).not.toHaveProperty('unconfirmed');
    management.mockResolvedValue({ ok: true, outcome: { method: 'session.state', result: { sessionId: 'legacy-session', state: 'waiting_user_action' } } });
    expect(await routeNetworkRequest('session/state', { sessionId: session }, 'internal-session'))
      .toMatchObject({ success: true, session: { sessionId: session, state: 'waiting_user_action' } });
    management.mockResolvedValue({ ok: true, outcome: { method: 'session.get', result: {} } });
    expect(await routeNetworkRequest('session/get', { sessionId: session }, 'internal-session'))
      .toMatchObject({ success: false, code: 'NETWORK_RECEIPT_INVALID' });
  });

});
