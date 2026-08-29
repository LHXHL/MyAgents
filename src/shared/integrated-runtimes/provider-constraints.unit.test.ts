import { describe, expect, it } from "vitest";

import {
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  MANAGED_CODEX_PROVIDER,
  PRESET_PROVIDERS,
  SUBSCRIPTION_PROVIDER_ID,
  XAI_SUBSCRIPTION_PROVIDER_ID,
  type Provider,
} from "../config-types";
import { getProviderExecutionConstraint } from "./provider-constraints";

function preset(id: string): Provider {
  const provider = PRESET_PROVIDERS.find((candidate) => candidate.id === id);
  if (!provider) throw new Error(`Missing Provider fixture ${id}`);
  return provider;
}

describe("Provider execution constraints", () => {
  it("keeps subscription credentials on their declared runtime owners", () => {
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
    expect(
      getProviderExecutionConstraint(preset(XAI_SUBSCRIPTION_PROVIDER_ID)),
    ).toEqual({
      kind: "requires-integrated-runtime",
      runtimeId: "claude-agent-sdk",
      providerId: XAI_SUBSCRIPTION_PROVIDER_ID,
    });
  });

  it("derives ordinary API families only from explicit protocol fields", () => {
    expect(getProviderExecutionConstraint(preset("anthropic-api"))).toEqual({
      kind: "portable",
      apiFamily: "anthropic-messages",
    });
    expect(getProviderExecutionConstraint(preset("zhipu-ai"))).toEqual({
      kind: "portable",
      apiFamily: "openai-completions",
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
    });
  });

  it("does not infer transport from a Provider name or URL", () => {
    expect(
      getProviderExecutionConstraint({
        id: "looks-like-openai",
        type: "api",
        apiProtocol: "anthropic",
        upstreamFormat: "responses",
      }),
    ).toEqual({
      kind: "portable",
      apiFamily: "anthropic-messages",
    });
  });

  it("fails closed for undeclared subscription owners", () => {
    expect(() =>
      getProviderExecutionConstraint({
        id: "future-subscription",
        type: "subscription",
      }),
    ).toThrow(/no declared execution owner/);
  });
});
