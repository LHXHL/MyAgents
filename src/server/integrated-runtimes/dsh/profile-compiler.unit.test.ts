import { describe, expect, it } from "vitest";

import { PRESET_PROVIDERS, type Provider } from "../../../shared/config-types";
import {
  compileDshModelExecutionProfile,
  dshProviderCredentialRef,
  DshProfileCompilerError,
} from "./profile-compiler";

function preset(id: string): Provider {
  const provider = PRESET_PROVIDERS.find((candidate) => candidate.id === id);
  if (!provider) throw new Error(`Missing Provider fixture ${id}`);
  return structuredClone(provider);
}

describe("DSH ModelExecutionProfile compiler", () => {
  it("compiles native DeepSeek only from the included candidate profile", () => {
    const profile = compileDshModelExecutionProfile({
      provider: preset("deepseek"),
      modelId: "deepseek-v4-flash",
    });
    expect(profile).toMatchObject({
      providerRouteId: "deepseek-official",
      api: "openai-completions",
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com",
      credentialRef: "MYAGENTS_PROVIDER_DEEPSEEK_API_KEY",
      contextWindow: 1_000_000,
      maxTokens: 32_768,
      reasoning: true,
      effort: "high",
    });
    expect(profile.revision).toMatch(/^myagents-dsh-profile-v1:[a-f0-9]{64}$/);
    expect(profile).not.toHaveProperty("compatibility");
    expect(Object.isFrozen(profile)).toBe(true);
  });

  it("preserves the configured Anthropic Messages and OpenAI Chat protocols", () => {
    const anthropic = compileDshModelExecutionProfile({
      provider: preset("anthropic-api"),
      modelId: "claude-sonnet-4-6",
    });
    expect(anthropic).toMatchObject({
      api: "anthropic-messages",
      providerRouteId: "myagents-anthropic-api-anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      contextWindow: 200_000,
      maxTokens: 64_000,
      inputModalities: ["text", "image"],
      compatibility: {
        version: 1,
        family: "anthropic-messages",
        credentialMode: "pi-ai-api-key",
      },
    });

    const zhipuCodingPlan = compileDshModelExecutionProfile({
      provider: preset("zhipu"),
      modelId: "glm-5.3",
    });
    expect(zhipuCodingPlan).toMatchObject({
      api: "anthropic-messages",
      providerRouteId: "myagents-zhipu-anthropic-messages",
      provider: "zhipu",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      inputModalities: ["text"],
      compatibility: {
        version: 1,
        family: "anthropic-messages",
        credentialMode: "pi-ai-api-key",
      },
    });

    const openai = compileDshModelExecutionProfile({
      provider: preset("zhipu-ai"),
      modelId: "glm-5.3",
    });
    expect(openai).toMatchObject({
      api: "openai-completions",
      providerRouteId: "myagents-zhipu-ai-openai-completions",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      inputModalities: ["text"],
      compatibility: {
        version: 1,
        family: "openai-completions",
        credentialMode: "pi-ai-api-key",
      },
    });
  });

  it("produces stable revisions without copying credential material", () => {
    const provider = preset("anthropic-api");
    provider.apiKey = "secret-canary-do-not-copy";
    const first = compileDshModelExecutionProfile({
      provider,
      modelId: "claude-haiku-4-5",
    });
    const second = compileDshModelExecutionProfile({
      provider,
      modelId: "claude-haiku-4-5",
    });
    expect(first.revision).toBe(second.revision);
    expect(JSON.stringify(first)).not.toContain("secret-canary-do-not-copy");
    expect(first.credentialRef).toBe(dshProviderCredentialRef("anthropic-api"));
  });

  it("rejects unallowlisted, subscription, OAuth, and catalog-only routes", () => {
    const cases: Array<[Provider, string]> = [
      [preset("deepseek"), "deepseek-v4-pro"],
      [preset("anthropic-sub"), "claude-sonnet-4-6"],
      [preset("xai-sub"), "grok-4.5"],
      [
        {
          ...preset("zhipu-ai"),
          id: "catalog-only",
          config: { baseUrl: "https://api.openai.com/v1" },
        },
        "glm-5.3",
      ],
    ];
    for (const [provider, modelId] of cases) {
      expect(() =>
        compileDshModelExecutionProfile({ provider, modelId }),
      ).toThrowError(
        expect.objectContaining({ code: "provider-cell-not-allowlisted" }),
      );
    }
  });

  it("rejects drift in endpoint, auth, model capacity, and Bridge-only overrides", () => {
    const endpoint = preset("zhipu-ai");
    endpoint.config.baseUrl = "https://proxy.example.invalid/v1";
    expect(() =>
      compileDshModelExecutionProfile({
        provider: endpoint,
        modelId: "glm-5.3",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "provider-facts-mismatch" }),
    );

    const capacity = preset("anthropic-api");
    const model = capacity.models.find(
      (candidate) => candidate.model === "claude-sonnet-4-6",
    );
    if (!model) throw new Error("Missing model fixture");
    model.contextLength = 123;
    expect(() =>
      compileDshModelExecutionProfile({
        provider: capacity,
        modelId: model.model,
      }),
    ).toThrowError(expect.objectContaining({ code: "model-facts-mismatch" }));

    const bridgeOverride = preset("zhipu-ai");
    bridgeOverride.maxOutputTokensParamName = "max_completion_tokens";
    expect(() =>
      compileDshModelExecutionProfile({
        provider: bridgeOverride,
        modelId: "glm-5.3",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "provider-facts-mismatch" }),
    );

    const runtimeBacked = preset("anthropic-api");
    runtimeBacked.execution = {
      kind: "runtime-backed",
      runtime: "codex",
      source: "managed-provider",
    };
    expect(() =>
      compileDshModelExecutionProfile({
        provider: runtimeBacked,
        modelId: "claude-sonnet-4-6",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "provider-facts-mismatch" }),
    );
  });

  it("allows only cell-declared reasoning selections", () => {
    const high = compileDshModelExecutionProfile({
      provider: preset("deepseek"),
      modelId: "deepseek-v4-flash",
      reasoningEffort: "max",
    });
    expect(high).toMatchObject({ reasoning: true, effort: "max" });

    expect(() =>
      compileDshModelExecutionProfile({
        provider: preset("zhipu-ai"),
        modelId: "glm-5.3",
        reasoningEffort: "high",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "reasoning-effort-unsupported",
      } satisfies Partial<DshProfileCompilerError>),
    );
  });
});
