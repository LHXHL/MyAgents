import { afterEach, describe, expect, it, vi } from "vitest";
const managementApi = vi.hoisted(() => vi.fn());
vi.mock("../utils/management-api-client", () => ({ managementApi }));
import { deliverNetworkReturn } from "./return";
import type { SendResultEvent } from "../inbox/session-event";

const reference = {
  opId: "00000000-0000-0000-0000-000000000001",
  returnRouteId: "00000000-0000-0000-0000-000000000002",
};
const event: SendResultEvent = {
  version: 1,
  type: "send.result",
  eventId: "00000000-0000-0000-0000-000000000003",
  requestEventId: "00000000-0000-0000-0000-000000000004",
  sourceSessionId: "target-session",
  targetSessionId: "remote-source",
  status: "ok",
  createdAt: "2026-10-01T00:00:00.000Z",
  payload: "result",
};
afterEach(() => {
  vi.unstubAllEnvs();
  managementApi.mockReset();
});
describe("terminal return transport", () => {
  it("requires the original live Sidecar and sends an opaque reference to the App", async () => {
    vi.stubEnv("MYAGENTS_SIDECAR_ID", "");
    expect(await deliverNetworkReturn(reference, event)).toBe("dropped");
    expect(managementApi).not.toHaveBeenCalled();
    vi.stubEnv("MYAGENTS_SIDECAR_ID", "sidecar-1");
    managementApi.mockResolvedValue({ ok: true, settlement: "delivered" });
    expect(await deliverNetworkReturn(reference, event)).toBe("delivered");
    expect(managementApi).toHaveBeenCalledWith(
      "/api/agent-network/return",
      "POST",
      {
        sidecarId: "sidecar-1",
        reference,
        event,
      },
      { timeoutMs: 32_000 },
    );
  });
  it("keeps transport ambiguity separate from a dropped route without retrying", async () => {
    vi.stubEnv("MYAGENTS_SIDECAR_ID", "sidecar-1");
    managementApi
      .mockResolvedValueOnce({ ok: false, code: "transport_outcome_unknown" })
      .mockResolvedValueOnce({ ok: false, code: "RETURN_ROUTE_LOST" });
    expect(await deliverNetworkReturn(reference, event)).toBe("unconfirmed");
    expect(await deliverNetworkReturn(reference, event)).toBe("dropped");
    expect(managementApi).toHaveBeenCalledTimes(2);
  });
});
