import { describe, expect, it } from "vitest";
import {
  filterMentionAgents,
  validateMentionAgent,
  type MentionAgentInfo,
} from "./agentDiscovery";
const local: MentionAgentInfo = {
  selector: "local",
  name: "Zeta",
  isLocal: true,
  deviceId: "device",
  deviceName: "我的电脑",
  platform: "macos",
  description: null,
  source: null,
};
const remote: MentionAgentInfo = {
  ...local,
  selector:
    "ma-agent:1:00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000002:00000000-0000-0000-0000-000000000003",
  name: "Alpha",
  isLocal: false,
  deviceId: "remote-device",
  description: "ＰＲ review",
  source: {
    serviceId: "00000000-0000-0000-0000-000000000001",
    networkId: "00000000-0000-0000-0000-000000000002",
  },
};
describe("mention discovery policy", () => {
  it("orders local first and searches normalized name/device/description only", () => {
    expect(
      filterMentionAgents([remote, local], "").map((item) => item.selector),
    ).toEqual([local.selector, remote.selector]);
    expect(filterMentionAgents([remote, local], "pr REVIEW")).toEqual([remote]);
    expect(filterMentionAgents([remote, local], "我的电脑")).toHaveLength(2);
  });
  it("accepts legacy discovery without icons and bounds optional display metadata", () => {
    expect(validateMentionAgent(remote)).toEqual(remote);
    expect(validateMentionAgent({ ...remote, icon: "lightning" })).toMatchObject({ icon: "lightning" });
    expect(validateMentionAgent({ ...remote, icon: null })).toMatchObject({ icon: null });
    expect(() => validateMentionAgent({ ...remote, icon: "x".repeat(257) })).toThrow();
  });
  it("rejects a network selector attributed to another network or local scope", () => {
    expect(() => validateMentionAgent({ ...remote, isLocal: true })).toThrow();
    expect(() =>
      validateMentionAgent({
        ...remote,
        source: {
          ...remote.source,
          networkId: "00000000-0000-0000-0000-000000000004",
        },
      }),
    ).toThrow();
    expect(validateMentionAgent(remote)).toEqual(remote);
  });
});
