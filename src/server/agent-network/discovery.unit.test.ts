import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ management: vi.fn() }));
vi.mock("../utils/management-api-client", () => ({
  managementApi: mocks.management,
}));
import { discoverAgents } from "./discovery";
const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const remote = (deviceId: string, localAgentId: string, mount = 3) => ({
  localAgentId,
  name: "Remote",
  icon: "lightning",
  description: "Introduction",
  deviceId,
  deviceName: "Other device",
  platform: "windows",
  selector: `ma-agent:1:${id(1)}:${id(2)}:${id(mount)}`,
  isLocal: false,
  source: { serviceId: id(1), networkId: id(2) },
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("MYAGENTS_SIDECAR_ID", "global");
});
describe("Agent discovery merge", () => {
  it("preserves local callability when the network is unavailable and reports incomplete explicitly", async () => {
    mocks.management.mockResolvedValue({
      ok: false,
      code: "network_unavailable",
    });
    expect(
      await discoverAgents([{ agentId: "local", name: "Local" }]),
    ).toMatchObject({
      items: [{ selector: "local", isLocal: true, source: null }],
      complete: false,
      networkStatus: "error",
    });
  });
  it("collapses only the actual owning device and local identity, and never exposes peer credentials", async () => {
    mocks.management.mockResolvedValue({
      ok: true,
      data: {
        items: [remote(id(4), "local"), remote(id(6), "local", 7)],
        complete: true,
        networkStatus: "ready",
        context: {
          authGeneration: 2,
          deviceId: id(4),
          deviceName: "This computer",
          platform: "macos",
          networkId: id(2),
          principalId: "account",
        },
      },
    });
    const result = await discoverAgents([
      { agentId: "local", name: "My local Agent" },
      { agentId: "archived", name: "Archived", archived: true },
    ]);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      selector: "local",
      name: "My local Agent",
      isLocal: true,
      description: "Introduction",
    });
    expect(result.items[1]).toMatchObject({
      selector: remote(id(6), "local", 7).selector,
      isLocal: false,
      deviceId: id(6),
      icon: "lightning",
    });
    expect(JSON.stringify(result)).not.toContain("signedBinding");
    expect(result).toMatchObject({ complete: true, authGeneration: 2 });
  });
  it("reads local-only identities with current account context without requiring cloud completion", async () => {
    mocks.management.mockResolvedValue({ ok: true, data: { items: [], complete: false, networkStatus: "ready", context: {
      authGeneration: 2, deviceId: id(4), deviceName: "This computer", platform: "macos", networkId: id(2), principalId: "account",
    } } });
    const result = await discoverAgents([{ agentId: "local", name: "Local", icon: "lightning" }], true);
    expect(mocks.management).toHaveBeenCalledWith("/api/agent-network/discovery", "POST", { sidecarId: "global", localOnly: true }, { timeoutMs: 8000 });
    expect(result).toMatchObject({ authGeneration: 2, principalId: "account", networkId: id(2), complete: false,
      items: [{ selector: "local", icon: "lightning", isLocal: true }] });
  });
  it("does not claim a malformed or partial page is a complete empty network", async () => {
    mocks.management.mockResolvedValue({
      ok: true,
      data: { items: [], complete: true },
    });
    expect(
      await discoverAgents([{ agentId: "local", name: "Local" }]),
    ).toMatchObject({ complete: false, networkStatus: "error" });
  });
});
