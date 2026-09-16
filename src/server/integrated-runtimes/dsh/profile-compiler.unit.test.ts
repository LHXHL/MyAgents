import { describe, expect, it } from "vitest";

import { PRESET_PROVIDERS, type Provider } from "../../../shared/config-types";
import {
  compileDshModelExecutionProfile,
  dshProviderCredentialRef,
  type DshProfileCompilerError,
} from "./profile-compiler";

function preset(id: string): Provider {
  const provider = PRESET_PROVIDERS.find((candidate) => candidate.id === id);
  if (!provider) throw new Error(`Missing Provider fixture ${id}`);
  return structuredClone(provider);
}

describe("DSH ModelExecutionProfile compiler", () => {
  it("uses each Token Dance model's supported transport without changing the saved Provider", () => {
    const provider = preset("tokendance");
    const saved = JSON.stringify(provider);
    for (const [modelId, api, baseUrl] of [
      ["deepseek-v4-pro-0813", "anthropic-messages", "https://tokendance.space/gateway"],
      ["qwen3.8-max-0902", "openai-responses", "https://tokendance.space/gateway/v1"],
      ["kimi-k3", "openai-completions", "https://tokendance.space/gateway/v1"],
    ] as const) {
      expect(compileDshModelExecutionProfile({ provider, modelId })).toMatchObject({ api, modelId, baseUrl });
    }
    expect(JSON.stringify(provider)).toBe(saved);
    expect(() => compileDshModelExecutionProfile({ provider, modelId: "missing-protocol" })).toThrow("no known supported conversation protocol");
  });

  it("compiles every configured model on the official DeepSeek native route", () => {
    for (const modelId of ["deepseek-v4-pro", "deepseek-flash"]) {
      const profile = compileDshModelExecutionProfile({
        provider: preset("deepseek"),
        modelId,
      });
      expect(profile).toMatchObject({
        providerRouteId: "deepseek-official",
        api: "openai-completions",
        provider: "deepseek",
        modelId,
        baseUrl: "https://api.deepseek.com",
        credentialRef: "MYAGENTS_PROVIDER_DEEPSEEK_API_KEY",
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        inputModalities: modelId === "deepseek-flash" ? ["text", "image"] : ["text"],
        reasoning: true,
        effort: "high",
      });
      expect(profile.revision).toMatch(/^myagents-dsh-profile-v1:[a-f0-9]{64}$/);
      expect(profile).not.toHaveProperty("compatibility");
      if (modelId === "deepseek-flash") expect(profile.systemPromptUpdate).toBe("in-history");
      else expect(profile).not.toHaveProperty("systemPromptUpdate");
      expect(Object.isFrozen(profile)).toBe(true);
    }
  });

  it("declares in-history only for an explicitly selected official deepseek-flash model", () => {
    const provider = preset("deepseek");
    provider.models = [{ model: "deepseek-flash", modelName: "Flash", modelSeries: "deepseek", inputModalities: ["text"] }];
    const before = JSON.stringify(provider);
    expect(compileDshModelExecutionProfile({ provider, modelId: "deepseek-flash" }))
      .toMatchObject({ modelId: "deepseek-flash", systemPromptUpdate: "in-history", inputModalities: ["text"] });
    expect(JSON.stringify(provider)).toBe(before);
    provider.config.baseUrl = "https://gateway.example.test/anthropic";
    expect(compileDshModelExecutionProfile({ provider, modelId: "deepseek-flash" }))
      .not.toHaveProperty("systemPromptUpdate");
    provider.models.push({ model: "unknown-model", modelName: "Unknown", modelSeries: "deepseek" });
    expect(compileDshModelExecutionProfile({ provider, modelId: "unknown-model" }))
      .toMatchObject({ modelId: "unknown-model", inputModalities: ["text"] });
  });

  it("compiles ordinary API Providers by their declared API family", () => {
    const anthropic = compileDshModelExecutionProfile({
      provider: preset("anthropic-api"),
      modelId: "claude-sonnet-5",
    });
    expect(anthropic).toMatchObject({
      api: "anthropic-messages",
      providerRouteId: "myagents-anthropic-api-anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      compatibility: { version: 1, family: "anthropic-messages" },
    });

    const chat = compileDshModelExecutionProfile({
      provider: preset("zhipu-ai"),
      modelId: "glm-5.3",
    });
    expect(chat).toMatchObject({
      api: "openai-completions",
      providerRouteId: "myagents-zhipu-ai-openai-completions",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      compatibility: { version: 1, family: "openai-completions" },
    });

    const responses = preset("zhipu-ai");
    responses.id = "custom-responses";
    responses.upstreamFormat = "responses";
    responses.config.baseUrl = "https://responses.example.test/v1/";
    const responseProfile = compileDshModelExecutionProfile({
      provider: responses,
      modelId: "glm-5.3",
    });
    expect(responseProfile).toMatchObject({
      api: "openai-responses",
      providerRouteId: "myagents-custom-responses-openai-responses",
      baseUrl: "https://responses.example.test/v1",
      compatibility: { version: 1, family: "openai-responses" },
    });
  });

  it("uses current Product endpoint and model capacity without a compatibility cell", () => {
    const provider = preset("moonshot");
    provider.id = "custom-moonshot";
    provider.config.baseUrl = "https://gateway.example.test/anthropic";
    provider.models = [{
      model: "future-model",
      modelName: "Future",
      modelSeries: "future",
    }];
    const profile = compileDshModelExecutionProfile({ provider, modelId: "future-model" });
    expect(profile).toMatchObject({
      provider: "custom-moonshot",
      modelId: "future-model",
      baseUrl: "https://gateway.example.test/anthropic",
      contextWindow: 200_000,
      maxTokens: 8_192,
      inputModalities: ["text"],
    });

    provider.models[0].contextLength = 300_000;
    provider.models[0].maxOutputTokens = 16_384;
    const changed = compileDshModelExecutionProfile({ provider, modelId: "future-model" });
    expect(changed).toMatchObject({ contextWindow: 300_000, maxTokens: 16_384 });
    expect(changed.revision).not.toBe(profile.revision);
  });

  it("maps supported OpenAI wire overrides instead of rejecting them", () => {
    const provider = preset("zhipu-ai");
    provider.maxOutputTokensParamName = "max_completion_tokens";
    const profile = compileDshModelExecutionProfile({ provider, modelId: "glm-5.3" });
    expect(profile.compatibility?.wireCompat).toEqual({
      maxTokensField: "max_completion_tokens",
    });
  });

  it("produces stable revisions without copying credential material", () => {
    const provider = preset("anthropic-api");
    provider.apiKey = "secret-canary-do-not-copy";
    const first = compileDshModelExecutionProfile({ provider, modelId: "claude-sonnet-5" });
    const second = compileDshModelExecutionProfile({ provider, modelId: "claude-sonnet-5" });
    expect(first.revision).toBe(second.revision);
    expect(JSON.stringify(first)).not.toContain("secret-canary-do-not-copy");
    expect(first.credentialRef).toBe(dshProviderCredentialRef("anthropic-api"));
  });

  it("rejects only invalid ownership, availability, endpoint, or capacity", () => {
    const subscription = preset("anthropic-sub");
    expect(() => compileDshModelExecutionProfile({
      provider: subscription,
      modelId: subscription.primaryModel,
    })).toThrowError(expect.objectContaining({
      code: "provider-execution-owner-unsupported",
    } satisfies Partial<DshProfileCompilerError>));

    const unavailable = preset("anthropic-api");
    expect(() => compileDshModelExecutionProfile({
      provider: unavailable,
      modelId: "not-configured",
    })).toThrowError(expect.objectContaining({ code: "model-unavailable" }));

    const disabled = preset("zhipu");
    disabled.enabled = false;
    expect(() => compileDshModelExecutionProfile({
      provider: disabled,
      modelId: disabled.primaryModel,
    })).toThrowError(expect.objectContaining({ code: "provider-disabled" }));

    const invalidEndpoint = preset("zhipu-ai");
    invalidEndpoint.config.baseUrl = "not-a-url";
    expect(() => compileDshModelExecutionProfile({
      provider: invalidEndpoint,
      modelId: invalidEndpoint.primaryModel,
    })).toThrowError(expect.objectContaining({ code: "provider-endpoint-invalid" }));

    const invalidCapacity = preset("zhipu-ai");
    invalidCapacity.models[0].contextLength = -1;
    expect(() => compileDshModelExecutionProfile({
      provider: invalidCapacity,
      modelId: invalidCapacity.models[0].model,
    })).toThrowError(expect.objectContaining({ code: "model-capabilities-invalid" }));
  });

  it("keeps explicit reasoning effort on the native route only", () => {
    const high = compileDshModelExecutionProfile({
      provider: preset("deepseek"),
      modelId: "deepseek-v4-pro",
      reasoningEffort: "max",
    });
    expect(high).toMatchObject({ reasoning: true, effort: "max" });

    expect(() => compileDshModelExecutionProfile({
      provider: preset("zhipu-ai"),
      modelId: "glm-5.3",
      reasoningEffort: "high",
    })).toThrowError(expect.objectContaining({
      code: "reasoning-effort-unsupported",
    } satisfies Partial<DshProfileCompilerError>));
  });
});
