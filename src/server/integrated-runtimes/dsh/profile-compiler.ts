import { createHash } from "node:crypto";

import type { ModelEntity, Provider } from "../../../shared/config-types";
import {
  DSH_PROVIDER_CELL_CONTRACT,
  findDshProviderCell,
  type DshInputModality,
  type DshProviderCompatibilityProfile,
  type DshProviderCell,
  type DshReasoningEffort,
} from "../../../shared/integrated-runtimes/dsh-provider-cells";

export type DshModelExecutionProfile = Readonly<{
  revision: string;
  providerRouteId: string;
  api: "anthropic-messages" | "openai-completions" | "openai-responses";
  provider: string;
  modelId: string;
  baseUrl?: string;
  credentialRef: string;
  contextWindow: number;
  maxTokens: number;
  inputModalities?: readonly DshInputModality[];
  pricing?: Readonly<{
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
    cacheReadUsdPerMillionTokens: number;
    cacheWriteUsdPerMillionTokens: number;
  }>;
  reasoning?: boolean;
  effort?: DshReasoningEffort;
  reasoningEffortMap?: Readonly<
    Partial<Record<"off", null>> & Partial<Record<DshReasoningEffort, string>>
  >;
  compatibility?: DshProviderCompatibilityProfile;
}>;

export type DshProfileCompilerErrorCode =
  | "provider-cell-not-allowlisted"
  | "provider-disabled"
  | "provider-facts-mismatch"
  | "model-facts-mismatch"
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

export type DshReasoningEffortSelection =
  | "default"
  | "off"
  | DshReasoningEffort;

type DshProfileCompilerProvider = Pick<
  Provider,
  | "id"
  | "type"
  | "enabled"
  | "execution"
  | "authType"
  | "apiProtocol"
  | "upstreamFormat"
  | "maxOutputTokens"
  | "maxOutputTokensParamName"
  | "config"
  | "models"
  | "apiKey"
>;

function mismatch(
  code: Extract<
    DshProfileCompilerErrorCode,
    "provider-facts-mismatch" | "model-facts-mismatch"
  >,
  cell: DshProviderCell,
  fact: string,
): never {
  throw new DshProfileCompilerError(
    code,
    cell.providerId,
    cell.modelId,
    `DSH cell ${cell.cellId} does not match current ${fact}`,
  );
}

function sameStrings(
  left: readonly string[] | undefined,
  right: readonly string[],
): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right);
}

function validateProviderFacts(
  provider: DshProfileCompilerProvider,
  cell: DshProviderCell,
): ModelEntity {
  if (provider.enabled === false) {
    throw new DshProfileCompilerError(
      "provider-disabled",
      cell.providerId,
      cell.modelId,
      `Provider ${cell.providerId} is disabled`,
    );
  }
  const apiProtocol = provider.apiProtocol ?? "anthropic";
  const upstreamFormat = provider.upstreamFormat ?? "chat_completions";
  const authType = provider.authType ?? "both";
  if (
    provider.id !== cell.providerId ||
    provider.type !== cell.product.type ||
    (provider.execution?.kind ?? "builtin") !== "builtin" ||
    authType !== cell.product.authType ||
    apiProtocol !== cell.product.apiProtocol ||
    upstreamFormat !== cell.product.upstreamFormat ||
    provider.config.baseUrl !== cell.product.baseUrl
  ) {
    mismatch("provider-facts-mismatch", cell, "Provider route facts");
  }
  if (
    provider.maxOutputTokens !== undefined ||
    provider.maxOutputTokensParamName !== undefined
  ) {
    mismatch("provider-facts-mismatch", cell, "Claude-SDK Bridge overrides");
  }

  const model = provider.models.find(
    (candidate) => candidate.model === cell.modelId,
  );
  if (!model) mismatch("model-facts-mismatch", cell, "Provider model catalog");
  if (
    model.contextLength !== cell.product.contextWindow ||
    model.maxOutputTokens !== cell.product.maxOutputTokens ||
    !sameStrings(model.inputModalities, cell.product.inputModalities)
  ) {
    mismatch("model-facts-mismatch", cell, "Provider model capabilities");
  }
  return model;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value))
    return value;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    deepFreeze(entry);
  }
  return Object.freeze(value);
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

function applyReasoningSelection(
  profile: Omit<DshModelExecutionProfile, "revision">,
  cell: DshProviderCell,
  selection: DshReasoningEffortSelection,
): Omit<DshModelExecutionProfile, "revision"> {
  if (selection === "default") return profile;
  if (cell.profile.source === "native-candidate") {
    if (selection === "off") {
      const { effort: _effort, ...withoutEffort } = profile;
      return { ...withoutEffort, reasoning: false };
    }
    if (!cell.profile.reasoningEfforts.includes(selection as "high" | "max")) {
      throw new DshProfileCompilerError(
        "reasoning-effort-unsupported",
        cell.providerId,
        cell.modelId,
        `DSH cell ${cell.cellId} does not support reasoning effort ${selection}`,
      );
    }
    return { ...profile, reasoning: true, effort: selection };
  }

  if (selection === "off") {
    const {
      effort: _effort,
      reasoningEffortMap: _reasoningEffortMap,
      ...withoutReasoning
    } = profile;
    return { ...withoutReasoning, reasoning: false };
  }
  if (!cell.profile.reasoningEffortMap?.[selection]) {
    throw new DshProfileCompilerError(
      "reasoning-effort-unsupported",
      cell.providerId,
      cell.modelId,
      `DSH cell ${cell.cellId} does not support reasoning effort ${selection}`,
    );
  }
  return { ...profile, reasoning: true, effort: selection };
}

function profileRevision(
  cell: DshProviderCell,
  profile: Omit<DshModelExecutionProfile, "revision">,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        contractId: DSH_PROVIDER_CELL_CONTRACT.contractId,
        runtimeProfileDigest: DSH_PROVIDER_CELL_CONTRACT.runtimeProfileDigest,
        cellId: cell.cellId,
        profile,
      }),
    )
    .digest("hex");
  return `myagents-dsh-profile-v1:${digest}`;
}

function nativeCandidateProfile(
  cell: DshProviderCell,
): Omit<DshModelExecutionProfile, "revision"> {
  if (cell.profile.source !== "native-candidate") {
    throw new Error("Expected one native DSH Provider cell");
  }
  return {
    providerRouteId: cell.profile.providerRouteId,
    api: cell.profile.api,
    provider: cell.profile.provider,
    modelId: cell.modelId,
    baseUrl: cell.profile.baseUrl,
    credentialRef: dshProviderCredentialRef(cell.providerId),
    contextWindow: cell.profile.contextWindow,
    maxTokens: cell.profile.maxTokens,
    reasoning: true,
    effort: "high",
  };
}

function piAiCellProfile(
  cell: DshProviderCell,
): Omit<DshModelExecutionProfile, "revision"> {
  if (cell.profile.source !== "pi-ai-cell") {
    throw new Error("Expected one pi-ai DSH Provider cell");
  }
  return {
    providerRouteId: cell.profile.providerRouteId,
    api: cell.profile.api,
    provider: cell.profile.provider,
    modelId: cell.modelId,
    baseUrl: cell.profile.baseUrl,
    credentialRef: dshProviderCredentialRef(cell.providerId),
    contextWindow: cell.profile.contextWindow,
    maxTokens: cell.profile.maxTokens,
    inputModalities: [...cell.profile.inputModalities],
    ...(cell.profile.reasoningEffortMap
      ? { reasoningEffortMap: { ...cell.profile.reasoningEffortMap } }
      : {}),
    compatibility: {
      ...cell.profile.compatibility,
      ...(cell.profile.compatibility.wireCompat
        ? { wireCompat: { ...cell.profile.compatibility.wireCompat } }
        : {}),
    },
  };
}

export function compileDshModelExecutionProfile(args: {
  provider: DshProfileCompilerProvider;
  modelId: string;
  reasoningEffort?: DshReasoningEffortSelection | null;
}): DshModelExecutionProfile {
  const cell = findDshProviderCell(args.provider.id, args.modelId);
  if (!cell) {
    throw new DshProfileCompilerError(
      "provider-cell-not-allowlisted",
      args.provider.id,
      args.modelId,
      `Provider/model ${args.provider.id}/${args.modelId} has no DSH compatibility cell`,
    );
  }
  validateProviderFacts(args.provider, cell);
  const base =
    cell.profile.source === "native-candidate"
      ? nativeCandidateProfile(cell)
      : piAiCellProfile(cell);
  const selected = applyReasoningSelection(
    base,
    cell,
    args.reasoningEffort ?? "default",
  );
  return deepFreeze({
    revision: profileRevision(cell, selected),
    ...selected,
  });
}
