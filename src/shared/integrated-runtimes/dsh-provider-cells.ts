import candidateProfileJson from "../../../contracts/myagents-dsh/batch-1-candidate-profile-v1.json";
import cellsJson from "./dsh-provider-cells-v1.json";
import dshLock from "./dsh-lock.json";
import {
  DSH_COMPATIBILITY,
  getDshApiFamilyCompatibility,
} from "./dsh-compatibility";
import type { ProviderAuthType } from "../config-types";
import type { DshApiFamily } from "./provider-constraints";

export type DshInputModality = "text" | "image";
export type DshReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type DshProviderWireCompatibilityV1 = Readonly<{
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  thinkingFormat?:
    | "openai"
    | "deepseek"
    | "openrouter"
    | "together"
    | "zai"
    | "qwen"
    | "chat-template"
    | "qwen-chat-template"
    | "string-thinking"
    | "ant-ling";
  supportsStrictMode?: boolean;
  supportsTemperature?: boolean;
  supportsStrictTools?: boolean;
}>;

export type DshProviderCompatibilityProfile = Readonly<{
  version: 1;
  family: DshApiFamily;
  credentialMode: "pi-ai-api-key";
  wireCompat?: DshProviderWireCompatibilityV1;
}>;

export type DshProductProviderFacts = Readonly<{
  type: "api";
  authType: ProviderAuthType;
  apiProtocol: "anthropic" | "openai";
  upstreamFormat: "chat_completions" | "responses";
  baseUrl: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputModalities: readonly string[];
}>;

type DshProviderProfileCellBase = Readonly<{
  providerRouteId: string;
  api: DshApiFamily;
  provider: string;
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
}>;

export type DshNativeProviderProfileCell = DshProviderProfileCellBase &
  Readonly<{
    source: "native-candidate";
    providerRouteId: "deepseek-official";
    api: "openai-completions";
    reasoningEfforts: readonly ("high" | "max")[];
  }>;

export type DshPiAiProviderProfileCell = DshProviderProfileCellBase &
  Readonly<{
    source: "pi-ai-cell";
    inputModalities: readonly DshInputModality[];
    reasoningEffortMap?: Readonly<
      Partial<Record<"off", null>> & Partial<Record<DshReasoningEffort, string>>
    >;
    compatibility: DshProviderCompatibilityProfile;
  }>;

export type DshProviderCell = Readonly<{
  cellId: string;
  providerId: string;
  modelId: string;
  product: DshProductProviderFacts;
  profile: DshNativeProviderProfileCell | DshPiAiProviderProfileCell;
}>;

export type DshProviderCellContract = Readonly<{
  schemaVersion: 1;
  contractId: "myagents-dsh-provider-cells-v1";
  runtimeProfileId: string;
  runtimeProfileDigest: string;
  compatibilitySha256: string;
  candidateProfileSha256: string;
  commonPiAiLimitations: readonly string[];
  cells: readonly DshProviderCell[];
}>;

function record(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown, description: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${description} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value: unknown, description: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${description} must be a positive safe integer`);
  }
  return value as number;
}

function canonicalHttpUrl(value: unknown, description: string): string {
  const raw = nonEmpty(value, description);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${description} must be an absolute URL`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${description} is not an approved HTTP(S) endpoint`);
  }
  if (raw !== url.toString() && `${raw}/` !== url.toString()) {
    throw new Error(`${description} is not canonically spelled`);
  }
  return raw;
}

function stringArray(value: unknown, description: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || !entry) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${description} must be a non-empty unique string array`);
  }
  return [...value];
}

function parseProductFacts(value: unknown): DshProductProviderFacts {
  const product = record(value, "DSH cell product facts");
  const authTypes: readonly ProviderAuthType[] = [
    "auth_token",
    "api_key",
    "both",
    "auth_token_clear_api_key",
  ];
  if (
    product.type !== "api" ||
    !authTypes.includes(product.authType as ProviderAuthType) ||
    (product.apiProtocol !== "anthropic" && product.apiProtocol !== "openai") ||
    (product.upstreamFormat !== "chat_completions" &&
      product.upstreamFormat !== "responses")
  ) {
    throw new Error("DSH cell has invalid product execution facts");
  }
  if (
    product.apiProtocol === "anthropic" &&
    product.upstreamFormat !== "chat_completions"
  ) {
    throw new Error("Anthropic product routes cannot declare Responses format");
  }
  return Object.freeze({
    type: "api",
    authType: product.authType as ProviderAuthType,
    apiProtocol: product.apiProtocol,
    upstreamFormat: product.upstreamFormat,
    baseUrl: canonicalHttpUrl(product.baseUrl, "DSH cell product base URL"),
    contextWindow: positiveInteger(
      product.contextWindow,
      "DSH cell context window",
    ),
    maxOutputTokens: positiveInteger(
      product.maxOutputTokens,
      "DSH cell max output",
    ),
    inputModalities: Object.freeze(
      stringArray(product.inputModalities, "DSH cell product modalities"),
    ),
  });
}

function parseCompatibility(
  value: unknown,
  api: DshApiFamily,
): DshProviderCompatibilityProfile {
  const compatibility = record(value, "DSH pi-ai compatibility profile");
  if (
    compatibility.version !== 1 ||
    compatibility.family !== api ||
    compatibility.credentialMode !== "pi-ai-api-key"
  ) {
    throw new Error("DSH pi-ai compatibility identity is invalid");
  }
  getDshApiFamilyCompatibility(api);
  const wireCompat = compatibility.wireCompat;
  let parsedWireCompat: DshProviderWireCompatibilityV1 | undefined;
  if (wireCompat !== undefined) {
    const wire = record(wireCompat, "DSH pi-ai wire compatibility");
    const allowedByFamily: Record<DshApiFamily, ReadonlySet<string>> = {
      "anthropic-messages": new Set([
        "supportsTemperature",
        "supportsStrictTools",
      ]),
      "openai-completions": new Set([
        "supportsDeveloperRole",
        "supportsReasoningEffort",
        "supportsUsageInStreaming",
        "maxTokensField",
        "requiresToolResultName",
        "requiresAssistantAfterToolResult",
        "thinkingFormat",
        "supportsStrictMode",
      ]),
      "openai-responses": new Set([
        "supportsDeveloperRole",
        "supportsStrictMode",
      ]),
    };
    const thinkingFormats = new Set([
      "openai",
      "deepseek",
      "openrouter",
      "together",
      "zai",
      "qwen",
      "chat-template",
      "qwen-chat-template",
      "string-thinking",
      "ant-ling",
    ]);
    for (const [field, fieldValue] of Object.entries(wire)) {
      if (!allowedByFamily[api].has(field)) {
        throw new Error(
          `DSH wire compatibility field ${field} is invalid for ${api}`,
        );
      }
      if (field === "maxTokensField") {
        if (
          fieldValue !== "max_tokens" &&
          fieldValue !== "max_completion_tokens"
        ) {
          throw new Error("DSH maxTokensField compatibility value is invalid");
        }
      } else if (field === "thinkingFormat") {
        if (
          typeof fieldValue !== "string" ||
          !thinkingFormats.has(fieldValue)
        ) {
          throw new Error("DSH thinkingFormat compatibility value is invalid");
        }
      } else if (typeof fieldValue !== "boolean") {
        throw new Error(
          `DSH wire compatibility field ${field} must be boolean`,
        );
      }
    }
    parsedWireCompat = Object.freeze({
      ...wire,
    }) as DshProviderWireCompatibilityV1;
  }
  return Object.freeze({
    version: 1,
    family: api,
    credentialMode: "pi-ai-api-key",
    ...(parsedWireCompat === undefined ? {} : { wireCompat: parsedWireCompat }),
  });
}

function parseReasoningEffortMap(
  value: unknown,
): DshPiAiProviderProfileCell["reasoningEffortMap"] {
  if (value === undefined) return undefined;
  const map = record(value, "DSH pi-ai reasoning effort map");
  const allowed = new Set(["off", "low", "medium", "high", "xhigh", "max"]);
  if (Object.keys(map).length === 0) {
    throw new Error("DSH pi-ai reasoning effort map cannot be empty");
  }
  for (const [effort, wireValue] of Object.entries(map)) {
    if (!allowed.has(effort)) {
      throw new Error(`DSH reasoning effort ${effort} is invalid`);
    }
    if (effort === "off") {
      if (wireValue !== null)
        throw new Error("DSH off effort must map to null");
    } else if (
      typeof wireValue !== "string" ||
      wireValue.length === 0 ||
      wireValue.length > 128
    ) {
      throw new Error(
        `DSH reasoning effort ${effort} has an invalid wire value`,
      );
    }
  }
  return Object.freeze({
    ...map,
  }) as DshPiAiProviderProfileCell["reasoningEffortMap"];
}

function parseCell(value: unknown): DshProviderCell {
  const cell = record(value, "DSH Provider cell");
  const cellId = nonEmpty(cell.cellId, "DSH cell id");
  const providerId = nonEmpty(cell.providerId, "DSH cell Provider id");
  const modelId = nonEmpty(cell.modelId, "DSH cell model id");
  const product = parseProductFacts(cell.product);
  const rawProfile = record(cell.profile, "DSH cell profile");
  const common = {
    providerRouteId: nonEmpty(
      rawProfile.providerRouteId,
      "DSH profile route id",
    ),
    api: rawProfile.api as DshApiFamily,
    provider: nonEmpty(rawProfile.provider, "DSH profile Provider identity"),
    baseUrl: canonicalHttpUrl(rawProfile.baseUrl, "DSH profile base URL"),
    contextWindow: positiveInteger(
      rawProfile.contextWindow,
      "DSH profile context window",
    ),
    maxTokens: positiveInteger(rawProfile.maxTokens, "DSH profile max tokens"),
  };
  if (common.provider !== providerId) {
    throw new Error(`DSH cell ${cellId} changes Provider identity`);
  }

  let profile: DshProviderCell["profile"];
  if (rawProfile.source === "native-candidate") {
    const candidate = record(
      candidateProfileJson,
      "DSH native candidate profile",
    );
    const efforts = stringArray(
      rawProfile.reasoningEfforts,
      "DSH native reasoning efforts",
    );
    if (
      candidate.profileId !== dshLock.profile.id ||
      providerId !== "deepseek" ||
      modelId !== "deepseek-v4-flash" ||
      common.providerRouteId !== "deepseek-official" ||
      common.api !== "openai-completions" ||
      common.provider !== "deepseek" ||
      common.baseUrl !== "https://api.deepseek.com" ||
      common.contextWindow !== 1_000_000 ||
      common.maxTokens !== 32_768 ||
      efforts.join(",") !== "high,max"
    ) {
      throw new Error(
        `DSH native cell ${cellId} differs from the candidate profile`,
      );
    }
    profile = Object.freeze({
      source: "native-candidate",
      ...common,
      providerRouteId: "deepseek-official",
      api: "openai-completions",
      reasoningEfforts: Object.freeze(["high", "max"] as const),
    });
  } else if (rawProfile.source === "pi-ai-cell") {
    if (
      common.api !== "anthropic-messages" &&
      common.api !== "openai-completions" &&
      common.api !== "openai-responses"
    ) {
      throw new Error(`DSH pi-ai cell ${cellId} has an unsupported API family`);
    }
    const expectedApi =
      product.apiProtocol === "anthropic"
        ? "anthropic-messages"
        : product.upstreamFormat === "responses"
          ? "openai-responses"
          : "openai-completions";
    if (
      common.api !== expectedApi ||
      common.baseUrl !== product.baseUrl ||
      common.contextWindow !== product.contextWindow ||
      common.maxTokens !== product.maxOutputTokens
    ) {
      throw new Error(
        `DSH pi-ai cell ${cellId} differs from product route facts`,
      );
    }
    const inputModalities = stringArray(
      rawProfile.inputModalities,
      "DSH pi-ai input modalities",
    );
    if (
      inputModalities[0] !== "text" ||
      inputModalities.some(
        (modality) => modality !== "text" && modality !== "image",
      ) ||
      JSON.stringify(inputModalities) !==
        JSON.stringify(product.inputModalities)
    ) {
      throw new Error(
        `DSH pi-ai cell ${cellId} has unsupported input modalities`,
      );
    }
    profile = Object.freeze({
      source: "pi-ai-cell",
      ...common,
      inputModalities: Object.freeze(
        inputModalities,
      ) as readonly DshInputModality[],
      ...(rawProfile.reasoningEffortMap === undefined
        ? {}
        : {
            reasoningEffortMap: parseReasoningEffortMap(
              rawProfile.reasoningEffortMap,
            ),
          }),
      compatibility: parseCompatibility(rawProfile.compatibility, common.api),
    });
  } else {
    throw new Error(`DSH cell ${cellId} has an unknown profile source`);
  }

  return Object.freeze({ cellId, providerId, modelId, product, profile });
}

export function parseDshProviderCellContract(
  value: unknown,
): DshProviderCellContract {
  const root = record(value, "DSH Provider cell contract");
  if (
    root.schemaVersion !== 1 ||
    root.contractId !== "myagents-dsh-provider-cells-v1"
  ) {
    throw new Error("DSH Provider cell contract identity is invalid");
  }
  if (
    root.runtimeProfileId !== dshLock.profile.id ||
    root.runtimeProfileDigest !== dshLock.profile.digest ||
    root.compatibilitySha256 !== dshLock.handoff.compatibilitySha256 ||
    root.candidateProfileSha256 !== dshLock.profile.digest
  ) {
    throw new Error(
      "DSH Provider cell contract does not match the committed handoff",
    );
  }
  const limitations = stringArray(
    root.commonPiAiLimitations,
    "DSH Provider cell limitations",
  );
  for (const limitation of limitations) {
    if (!DSH_COMPATIBILITY.limitationIds.has(limitation)) {
      throw new Error(
        `DSH Provider cell limitation ${limitation} is not manifested`,
      );
    }
  }
  if (!Array.isArray(root.cells) || root.cells.length === 0) {
    throw new Error("DSH Provider cell contract must contain cells");
  }
  const cells = root.cells.map(parseCell);
  const ids = cells.map((cell) => cell.cellId);
  const routes = cells.map((cell) => `${cell.providerId}\u0000${cell.modelId}`);
  if (
    new Set(ids).size !== ids.length ||
    new Set(routes).size !== routes.length
  ) {
    throw new Error("DSH Provider cell identities must be unique");
  }
  return Object.freeze({
    schemaVersion: 1,
    contractId: "myagents-dsh-provider-cells-v1",
    runtimeProfileId: root.runtimeProfileId as string,
    runtimeProfileDigest: root.runtimeProfileDigest as string,
    compatibilitySha256: root.compatibilitySha256 as string,
    candidateProfileSha256: root.candidateProfileSha256 as string,
    commonPiAiLimitations: Object.freeze(limitations),
    cells: Object.freeze(cells),
  });
}

export const DSH_PROVIDER_CELL_CONTRACT =
  parseDshProviderCellContract(cellsJson);

export function findDshProviderCell(
  providerId: string,
  modelId: string,
): DshProviderCell | undefined {
  return DSH_PROVIDER_CELL_CONTRACT.cells.find(
    (cell) => cell.providerId === providerId && cell.modelId === modelId,
  );
}

export function isDshProviderModelCompatible(
  providerId: string,
  modelId: string,
): boolean {
  return findDshProviderCell(providerId, modelId) !== undefined;
}
