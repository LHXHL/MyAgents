import { beforeEach, describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import {
  networkErrorKey,
  networkRequest,
  type NetworkRequest,
} from "./agentNetwork";
beforeEach(() => invoke.mockReset());
describe("network read and settings outcome", () => {
  it.each([
    "NETWORK_TRANSPORT_FAILED",
    "NETWORK_REQUEST_UNCONFIRMED",
    "MUTATION_RESULT_UNKNOWN",
  ])("keeps %s save wording scoped to mutations", (code) => {
    expect(networkErrorKey({ code })).toBe("failed");
    expect(networkErrorKey({ code }, "mutation")).toBe("unconfirmed");
  });
  it("never checks a mutation receipt for a failed read", async () => {
    const error = { code: "NETWORK_TRANSPORT_FAILED" };
    invoke.mockRejectedValueOnce(error);
    await expect(networkRequest({ kind: "network" })).rejects.toBe(error);
    expect(invoke).toHaveBeenCalledOnce();
  });
  const mutations: NetworkRequest[] = [
    {
      kind: "membership",
      networkId: "net",
      deviceId: "device",
      joined: true,
      mutationId: "mutation",
      expectedMembershipRevision: 1,
    },
    {
      kind: "enabled",
      networkId: "net",
      mountId: "mount",
      enabled: true,
      mutationId: "mutation",
      expectedMembershipRevision: 1,
      expectedEnableRevision: 1,
    },
    {
      kind: "description",
      networkId: "net",
      mountId: "mount",
      description: "draft",
      mutationId: "mutation",
      expectedMembershipRevision: 1,
      expectedDescriptionRevision: 1,
    },
  ];
  it.each(mutations)(
    "checks only the receipt of an uncertain $kind write",
    async (request) => {
      const receipt = { revision: 2 };
      invoke
        .mockRejectedValueOnce({ code: "NETWORK_REQUEST_UNCONFIRMED" })
        .mockResolvedValueOnce(receipt);
      await expect(networkRequest(request)).resolves.toBe(receipt);
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(invoke).toHaveBeenLastCalledWith("cmd_agent_network_request", {
        request: { kind: "receipt", mutationId: "mutation" },
      });
    },
  );
  it.each(mutations)(
    "retains uncertainty after a failed $kind receipt read",
    async (request) => {
      const error = { code: "NETWORK_TRANSPORT_FAILED" };
      invoke
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce({ code: "CONNECTOR_NOT_READY" });
      await expect(networkRequest(request)).rejects.toBe(error);
      expect(invoke).toHaveBeenCalledTimes(2);
    },
  );
  it("does not probe or retry a definite conflict", async () => {
    const error = { code: "REVISION_CONFLICT" };
    invoke.mockRejectedValueOnce(error);
    await expect(networkRequest(mutations[0])).rejects.toBe(error);
    expect(invoke).toHaveBeenCalledOnce();
    expect(networkErrorKey(error, "mutation")).toBe("conflict");
  });
});
