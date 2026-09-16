import {
  ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID,
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  SUBSCRIPTION_PROVIDER_ID,
  XAI_SUBSCRIPTION_PROVIDER_ID,
  type Provider,
} from "../config-types";

export type DshApiFamily =
  | "anthropic-messages"
  | "openai-completions"
  | "openai-responses";

export type ApiFamily = DshApiFamily;

export const OFFICIAL_DEEPSEEK_ANTHROPIC_BASE_URL =
  "https://api.deepseek.com/anthropic";

export type ProviderExecutionConstraint =
  | { kind: "portable"; apiFamily: ApiFamily }
  | {
      kind: "requires-integrated-runtime";
      runtimeId: "claude-agent-sdk";
      providerId:
        | typeof SUBSCRIPTION_PROVIDER_ID
        | typeof XAI_SUBSCRIPTION_PROVIDER_ID
        | typeof ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID;
    }
  | {
      kind: "requires-managed-runtime";
      runtimeId: "managed-codex";
      providerId: typeof CODEX_SUBSCRIPTION_PROVIDER_ID;
    };

type ProviderConstraintShape = Pick<
  Provider,
  "id" | "type" | "execution" | "apiProtocol" | "upstreamFormat"
>;

/**
 * Resolve the product execution requirement from explicit Provider fields.
 *
 * Ordinary API Providers are portable by their declared wire family. Product
 * Provider and model records remain the authority for route-specific facts.
 */
export function getProviderExecutionConstraint(
  provider: ProviderConstraintShape,
): ProviderExecutionConstraint {
  if (provider.id === CODEX_SUBSCRIPTION_PROVIDER_ID) {
    return {
      kind: "requires-managed-runtime",
      runtimeId: "managed-codex",
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
    };
  }
  if (provider.id === SUBSCRIPTION_PROVIDER_ID) {
    return {
      kind: "requires-integrated-runtime",
      runtimeId: "claude-agent-sdk",
      providerId: SUBSCRIPTION_PROVIDER_ID,
    };
  }
  if (provider.id === XAI_SUBSCRIPTION_PROVIDER_ID || provider.id === ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID) {
    return {
      kind: "requires-integrated-runtime",
      runtimeId: "claude-agent-sdk",
      providerId: provider.id,
    };
  }
  if (provider.type === "subscription") {
    throw new Error(
      `Subscription Provider ${provider.id} has no declared execution owner`,
    );
  }
  if (provider.execution?.kind === "runtime-backed") {
    throw new Error(
      `Provider ${provider.id} is owned by ${provider.execution.runtime}`,
    );
  }
  if (provider.apiProtocol === undefined || provider.apiProtocol === "anthropic") {
    if (provider.upstreamFormat === "responses") {
      throw new Error(
        `Anthropic Provider ${provider.id} cannot use the OpenAI Responses format`,
      );
    }
    return { kind: "portable", apiFamily: "anthropic-messages" };
  }
  if (provider.apiProtocol !== "openai") {
    throw new Error(`Provider ${provider.id} declares an unsupported API protocol`);
  }
  if (
    provider.upstreamFormat !== undefined
    && provider.upstreamFormat !== "chat_completions"
    && provider.upstreamFormat !== "responses"
  ) {
    throw new Error(`Provider ${provider.id} declares an unsupported OpenAI format`);
  }
  return {
    kind: "portable",
    apiFamily:
      provider.upstreamFormat === "responses"
        ? "openai-responses"
        : "openai-completions",
  };
}

type DshSelectableProviderShape = Pick<
  Provider,
  | "id"
  | "type"
  | "execution"
  | "enabled"
  | "apiProtocol"
  | "upstreamFormat"
  | "models"
>;

export function isDshApiProviderEligible(
  provider: DshSelectableProviderShape,
): boolean {
  if (provider.enabled === false || provider.type !== "api") return false;
  try {
    return getProviderExecutionConstraint(provider).kind === "portable";
  } catch {
    return false;
  }
}

export function isDshApiModelSelectable(
  provider: DshSelectableProviderShape,
  modelId: string | null | undefined,
): boolean {
  const model = modelId?.trim();
  return isDshApiProviderEligible(provider)
    && !!model
    && provider.models.some((candidate) => candidate.model === model);
}
