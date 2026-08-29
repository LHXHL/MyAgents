import { describe, expect, it } from "vitest";

import {
  AGENT_RUNTIME_DISTRIBUTION_POLICY,
  isRuntimeSelectorAvailable,
  parseAgentRuntimeDistributionPolicy,
} from "./distribution-policy";

describe("Agent Runtime distribution policy", () => {
  it("loads the controlled-rollout product policy", () => {
    expect(AGENT_RUNTIME_DISTRIBUTION_POLICY).toEqual({
      schemaVersion: 1,
      allowedIntegratedRuntimes: ["claude-agent-sdk", "dsh"],
      allowedExternalRuntimes: ["claude-code", "codex", "gemini"],
      defaultIntegratedRuntime: "claude-agent-sdk",
      selectorAvailability: "labs",
    });
    expect(
      isRuntimeSelectorAvailable(AGENT_RUNTIME_DISTRIBUTION_POLICY, false),
    ).toBe(false);
    expect(
      isRuntimeSelectorAvailable(AGENT_RUNTIME_DISTRIBUTION_POLICY, true),
    ).toBe(true);
  });

  it("accepts a valid DSH-only hidden distribution", () => {
    expect(
      parseAgentRuntimeDistributionPolicy({
        schemaVersion: 1,
        allowedIntegratedRuntimes: ["dsh"],
        allowedExternalRuntimes: [],
        defaultIntegratedRuntime: "dsh",
        selectorAvailability: "hidden",
      }),
    ).toMatchObject({
      allowedIntegratedRuntimes: ["dsh"],
      defaultIntegratedRuntime: "dsh",
      selectorAvailability: "hidden",
    });
  });

  it("rejects unknown, duplicate, empty, and inconsistent policy", () => {
    const base = {
      schemaVersion: 1,
      allowedIntegratedRuntimes: ["claude-agent-sdk"],
      allowedExternalRuntimes: ["codex"],
      defaultIntegratedRuntime: "claude-agent-sdk",
      selectorAvailability: "labs",
    };
    expect(() =>
      parseAgentRuntimeDistributionPolicy({
        ...base,
        allowedIntegratedRuntimes: [],
      }),
    ).toThrow(/invalid Integrated/);
    expect(() =>
      parseAgentRuntimeDistributionPolicy({
        ...base,
        allowedExternalRuntimes: ["codex", "codex"],
      }),
    ).toThrow(/invalid External/);
    expect(() =>
      parseAgentRuntimeDistributionPolicy({
        ...base,
        defaultIntegratedRuntime: "dsh",
      }),
    ).toThrow(/must be allowed/);
    expect(() =>
      parseAgentRuntimeDistributionPolicy({
        ...base,
        allowedIntegratedRuntimes: ["pi"],
        defaultIntegratedRuntime: "pi",
      }),
    ).toThrow(/invalid Integrated/);
  });
});
