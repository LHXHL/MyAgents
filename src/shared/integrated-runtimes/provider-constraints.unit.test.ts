import { describe, expect, it } from "vitest";

import {
  ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID,
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  MANAGED_CODEX_PROVIDER,
  PRESET_PROVIDERS,
  SUBSCRIPTION_PROVIDER_ID,
  XAI_SUBSCRIPTION_PROVIDER_ID,
  type Provider,
} from "../config-types";
import {
  getProviderExecutionConstraint,
  isDshModelSelectable,
  isDshProviderEligible,
} from "./provider-constraints";

function preset(id: string): Provider {
  const provider = PRESET_PROVIDERS.find((candidate) => candidate.id === id);
  if (!provider) throw new Error(`Missing Provider fixture ${id}`);
  return provider;
}

describe("Provider execution constraints", () => {
  it("reserves Claude and Managed Codex for their execution owners", () => {
    expect(
      getProviderExecutionConstraint(preset(SUBSCRIPTION_PROVIDER_ID)),
    ).toEqual({
      kind: "requires-integrated-runtime",
      runtimeId: "claude-agent-sdk",
      providerId: SUBSCRIPTION_PROVIDER_ID,
    });
    expect(getProviderExecutionConstraint(MANAGED_CODEX_PROVIDER)).toEqual({
      kind: "requires-managed-runtime",
      runtimeId: "managed-codex",
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
    });
    expect(getProviderExecutionConstraint(preset("anthropic-api"))).toEqual({
      kind: "requires-integrated-runtime",
      runtimeId: "claude-agent-sdk",
      providerId: "anthropic-api",
    });
  });

  it("admits Host-managed API routes by their declared wire family", () => {
    expect(getProviderExecutionConstraint(preset(XAI_SUBSCRIPTION_PROVIDER_ID))).toEqual({
      kind: "portable", apiFamily: "openai-responses", credentialKind: "host-managed-oauth",
    });
    expect(isDshProviderEligible(preset(XAI_SUBSCRIPTION_PROVIDER_ID))).toBe(true);
    const provider = preset(ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID);
    expect(getProviderExecutionConstraint(provider)).toEqual({
      kind: "portable", apiFamily: "anthropic-messages", credentialKind: "proxy-managed",
    });
    expect(isDshProviderEligible(provider)).toBe(true);
  });

  it("derives ordinary API families only from explicit protocol fields", () => {
    expect(getProviderExecutionConstraint(preset("zhipu"))).toEqual({
      kind: "portable",
      apiFamily: "anthropic-messages",
      credentialKind: "api-key",
    });
    expect(getProviderExecutionConstraint(preset("zhipu-ai"))).toEqual({
      kind: "portable",
      apiFamily: "openai-completions",
      credentialKind: "api-key",
    });
    expect(
      getProviderExecutionConstraint({
        id: "fixture-responses",
        type: "api",
        apiProtocol: "openai",
        upstreamFormat: "responses",
      }),
    ).toEqual({
      kind: "portable",
      apiFamily: "openai-responses",
      credentialKind: "api-key",
    });
  });

  it("rejects contradictory protocol fields without inferring from names or URLs", () => {
    expect(() =>
      getProviderExecutionConstraint({
        id: "looks-like-openai",
        type: "api",
        apiProtocol: "anthropic",
        upstreamFormat: "responses",
      }),
    ).toThrow(/cannot use the OpenAI Responses format/);
  });

  it("fails closed for undeclared subscription owners", () => {
    expect(() =>
      getProviderExecutionConstraint({
        id: "future-subscription",
        type: "subscription",
      }),
    ).toThrow(/no declared execution owner/);
    expect(() => getProviderExecutionConstraint({
      id: XAI_SUBSCRIPTION_PROVIDER_ID,
      type: "api",
      apiProtocol: "openai",
      upstreamFormat: "responses",
    })).toThrow(/Host-managed OAuth and OpenAI Responses/);
    expect(() => getProviderExecutionConstraint({
      id: ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID,
      type: "subscription",
      subscriptionAuth: { kind: "host-managed-oauth" },
    })).toThrow(/CLIProxy and Anthropic Messages/);
  });

  it("admits current ordinary API models without a Provider/model allowlist", () => {
    const deepseek = preset("deepseek");
    expect(isDshProviderEligible(deepseek)).toBe(true);
    expect(isDshModelSelectable(deepseek, "deepseek-v4-pro")).toBe(true);
    expect(isDshModelSelectable(deepseek, "deepseek-flash")).toBe(true);
    expect(isDshModelSelectable(deepseek, "not-configured")).toBe(false);
    expect(isDshProviderEligible(preset("anthropic-sub"))).toBe(false);
    expect(isDshProviderEligible(preset("anthropic-api"))).toBe(false);
  });
});
