import {
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

export type ProviderExecutionConstraint =
  | { kind: "portable"; apiFamily: ApiFamily }
  | {
      kind: "requires-integrated-runtime";
      runtimeId: "claude-agent-sdk";
      providerId:
        | typeof SUBSCRIPTION_PROVIDER_ID
        | typeof XAI_SUBSCRIPTION_PROVIDER_ID;
    }
  | {
      kind: "requires-managed-runtime";
      runtimeId: "managed-codex";
      providerId: typeof CODEX_SUBSCRIPTION_PROVIDER_ID;
    };

type ProviderConstraintShape = Pick<
  Provider,
  "id" | "type" | "apiProtocol" | "upstreamFormat"
>;

/**
 * Resolve the product execution requirement from explicit Provider fields.
 *
 * This is intentionally independent from the DSH Provider/model cell table:
 * a transport family describes the ordinary Provider route, while one exact
 * DSH cell is still required before DSH readiness may admit that route.
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
  if (provider.id === XAI_SUBSCRIPTION_PROVIDER_ID) {
    return {
      kind: "requires-integrated-runtime",
      runtimeId: "claude-agent-sdk",
      providerId: XAI_SUBSCRIPTION_PROVIDER_ID,
    };
  }
  if (provider.type === "subscription") {
    throw new Error(
      `Subscription Provider ${provider.id} has no declared execution owner`,
    );
  }
  if (provider.apiProtocol !== "openai") {
    return { kind: "portable", apiFamily: "anthropic-messages" };
  }
  return {
    kind: "portable",
    apiFamily:
      provider.upstreamFormat === "responses"
        ? "openai-responses"
        : "openai-completions",
  };
}
