import type { MethodParams } from "./protocol-types";
import { createHash } from "node:crypto";

import type { Provider } from "../../../shared/config-types";
import { resolveProviderForModel } from "../../../shared/tokendance";
import { SDK_DEFAULT_CONTEXT_WINDOW } from "../../../shared/contextUsage";
import dshLock from "../../../shared/integrated-runtimes/dsh-lock.json";
import {
  getProviderExecutionConstraint,
  OFFICIAL_DEEPSEEK_ANTHROPIC_BASE_URL,
} from "../../../shared/integrated-runtimes/provider-constraints";

export type DshInputModality = "text" | "image";
export type DshReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type DshModelExecutionProfile = MethodParams<'session/create'>['provider'];
export type DshProviderCompatibilityProfile = NonNullable<DshModelExecutionProfile['compatibility']>;
export type DshProviderWireCompatibilityV1 = NonNullable<DshProviderCompatibilityProfile['wireCompat']>;

export type DshProfileCompilerErrorCode =
  | "provider-disabled"
  | "provider-execution-owner-unsupported"
  | "provider-api-family-unsupported"
  | "provider-endpoint-invalid"
  | "model-unavailable"
  | "model-capabilities-invalid"
  | "reasoning-effort-unsupported";

export class DshProfileCompilerError extends Error {
  readonly code: DshProfileCompilerErrorCode;
  readonly providerId: string;
  readonly modelId: string;

  constructor(
    code: DshProfileCompilerErrorCode,
    providerId: string,
    modelId: string,
    message: string,
  ) {
    super(message);
    this.name = "DshProfileCompilerError";
    this.code = code;
    this.providerId = providerId;
    this.modelId = modelId;
  }
}

export type DshReasoningEffortSelection = "default" | "off" | DshReasoningEffort;

type DshProfileCompilerProvider = Pick<
  Provider,
  | "id"
  | "type"
  | "enabled"
  | "execution"
  | "apiProtocol"
  | "upstreamFormat"
  | "maxOutputTokens"
  | "maxOutputTokensParamName"
  | "config"
  | "models"
>;

const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const OFFICIAL_DEEPSEEK_RUNTIME_BASE_URL = "https://api.deepseek.com";

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return Object.freeze(value);
}

function boundedIdentity(value: string, description: string): string {
  const hasControlCharacter = [...value].some(character => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (!value || value.length > 256 || hasControlCharacter) {
    throw new Error(`${description} is not a valid DSH identifier`);
  }
  return value;
}

function canonicalHttpUrl(value: string | undefined): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value ?? "");
  } catch {
    throw new Error("Provider base URL must be an absolute HTTP(S) URL");
  }
  if (
    (endpoint.protocol !== "https:" && endpoint.protocol !== "http:")
    || !endpoint.hostname
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
  ) {
    throw new Error(
      "Provider base URL must be an absolute HTTP(S) URL without credentials, query or fragment",
    );
  }
  return endpoint.toString().replace(/\/$/u, "");
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const candidate = value ?? fallback;
  return Number.isSafeInteger(candidate) && candidate > 0 ? candidate : 0;
}

function modelCapabilities(
  provider: DshProfileCompilerProvider,
  modelId: string,
): Readonly<{
  contextWindow: number;
  maxTokens: number;
  inputModalities: readonly DshInputModality[];
}> {
  const model = provider.models.find((candidate) => candidate.model === modelId);
  if (!model) {
    throw new DshProfileCompilerError(
      "model-unavailable",
      provider.id,
      modelId,
      `Model ${modelId} is not configured for Provider ${provider.id}`,
    );
  }
  const contextWindow = positiveInteger(model.contextLength, SDK_DEFAULT_CONTEXT_WINDOW);
  const maxTokens = positiveInteger(
    model.maxOutputTokens ?? provider.maxOutputTokens,
    DEFAULT_MAX_OUTPUT_TOKENS,
  );
  if (!contextWindow || !maxTokens) {
    throw new DshProfileCompilerError(
      "model-capabilities-invalid",
      provider.id,
      modelId,
      `Model ${provider.id}/${modelId} has invalid token capacity`,
    );
  }
  const inputModalities = Object.freeze([
    "text" as const,
    ...(model.inputModalities?.includes("image") ? ["image" as const] : []),
  ]);
  return Object.freeze({ contextWindow, maxTokens, inputModalities });
}

function assertCredentialRef(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(value)) {
    throw new Error("Generated DSH Provider credential reference is invalid");
  }
  return value;
}

export function dshProviderCredentialRef(providerId: string): string {
  const normalized = providerId.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return assertCredentialRef(`MYAGENTS_PROVIDER_${normalized}_API_KEY`);
}

export function isOfficialDeepSeekDshRoute(
  provider: Pick<Provider, "id" | "type" | "execution" | "apiProtocol" | "upstreamFormat" | "config">,
): boolean {
  return provider.id === "deepseek"
    && provider.type === "api"
    && (provider.execution?.kind ?? "builtin") === "builtin"
    && (provider.apiProtocol ?? "anthropic") === "anthropic"
    && (provider.upstreamFormat ?? "chat_completions") === "chat_completions"
    && provider.config.baseUrl === OFFICIAL_DEEPSEEK_ANTHROPIC_BASE_URL;
}

function applyReasoningSelection(
  profile: Omit<DshModelExecutionProfile, "revision">,
  selection: DshReasoningEffortSelection,
  nativeDeepSeek: boolean,
): Omit<DshModelExecutionProfile, "revision"> {
  if (selection === "default") return profile;
  if (selection === "off") {
    const { effort: _effort, reasoningEffortMap: _map, ...withoutEffort } = profile;
    return { ...withoutEffort, reasoning: false };
  }
  if (!nativeDeepSeek || (selection !== "high" && selection !== "max")) {
    throw new DshProfileCompilerError(
      "reasoning-effort-unsupported",
      profile.provider,
      profile.modelId,
      `Provider/model ${profile.provider}/${profile.modelId} does not declare reasoning effort ${selection}`,
    );
  }
  return { ...profile, reasoning: true, effort: selection };
}

function profileRevision(profile: Omit<DshModelExecutionProfile, "revision">): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ runtimeProfileDigest: dshLock.profile.digest, profile }))
    .digest("hex");
  return `myagents-dsh-profile-v1:${digest}`;
}

function genericCompatibility(
  provider: DshProfileCompilerProvider,
  family: "anthropic-messages" | "openai-completions" | "openai-responses",
): DshProviderCompatibilityProfile {
  const maxTokensField = family === "openai-completions"
    && (provider.maxOutputTokensParamName === "max_tokens"
      || provider.maxOutputTokensParamName === "max_completion_tokens")
    ? provider.maxOutputTokensParamName
    : undefined;
  return {
    version: 1,
    family,
    credentialMode: "pi-ai-api-key",
    ...(maxTokensField ? { wireCompat: { maxTokensField } } : {}),
  };
}

export function compileDshModelExecutionProfile(args: {
  provider: DshProfileCompilerProvider;
  modelId: string;
  reasoningEffort?: DshReasoningEffortSelection | null;
}): DshModelExecutionProfile {
  const provider = resolveProviderForModel(args.provider, args.modelId);
  const providerId = boundedIdentity(provider.id, "Provider id");
  const modelId = boundedIdentity(args.modelId, "Model id");
  if (provider.enabled === false) {
    throw new DshProfileCompilerError(
      "provider-disabled",
      providerId,
      modelId,
      `Provider ${providerId} is disabled`,
    );
  }

  let constraint: ReturnType<typeof getProviderExecutionConstraint>;
  try {
    constraint = getProviderExecutionConstraint(provider);
  } catch (error) {
    throw new DshProfileCompilerError(
      provider.type === "api"
        ? "provider-api-family-unsupported"
        : "provider-execution-owner-unsupported",
      providerId,
      modelId,
      error instanceof Error ? error.message : `Provider ${providerId} cannot execute in DSH`,
    );
  }
  if (constraint.kind !== "portable" || provider.type !== "api") {
    throw new DshProfileCompilerError(
      "provider-execution-owner-unsupported",
      providerId,
      modelId,
      `Provider ${providerId} belongs to another execution owner`,
    );
  }

  let baseUrl: string;
  try {
    baseUrl = canonicalHttpUrl(provider.config.baseUrl);
  } catch (error) {
    throw new DshProfileCompilerError(
      "provider-endpoint-invalid",
      providerId,
      modelId,
      error instanceof Error ? error.message : `Provider ${providerId} has an invalid endpoint`,
    );
  }
  const capabilities = modelCapabilities(provider, modelId);
  const nativeDeepSeek = isOfficialDeepSeekDshRoute(provider);
  const base: Omit<DshModelExecutionProfile, "revision"> = nativeDeepSeek
    ? {
        providerRouteId: "deepseek-official",
        api: "openai-completions",
        provider: providerId,
        modelId,
        baseUrl: OFFICIAL_DEEPSEEK_RUNTIME_BASE_URL,
        credentialRef: dshProviderCredentialRef(providerId),
        contextWindow: capabilities.contextWindow,
        maxTokens: capabilities.maxTokens,
        inputModalities: capabilities.inputModalities,
        // Fixed DSH rc.2 official model catalog; gateways and other model IDs
        // must not inherit this wire capability from a Provider brand.
        ...(modelId === "deepseek-flash" ? { systemPromptUpdate: "in-history" as const } : {}),
        reasoning: true,
        effort: "high",
      }
    : {
        providerRouteId: boundedIdentity(
          `myagents-${providerId}-${constraint.apiFamily}`,
          "Provider route id",
        ),
        api: constraint.apiFamily,
        provider: providerId,
        modelId,
        baseUrl,
        credentialRef: dshProviderCredentialRef(providerId),
        contextWindow: capabilities.contextWindow,
        maxTokens: capabilities.maxTokens,
        inputModalities: capabilities.inputModalities,
        compatibility: genericCompatibility(provider, constraint.apiFamily),
      };
  const selected = applyReasoningSelection(
    base,
    args.reasoningEffort ?? "default",
    nativeDeepSeek,
  );
  return deepFreeze({ revision: profileRevision(selected), ...selected });
}
