import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";

import dshLock from "../../../shared/integrated-runtimes/dsh-lock.json";
import type {
  DshExecutionEnvironment,
  DshInitializeParams,
  DshProtocolLimits,
} from "./protocol-types";

export const DSH_DEFAULT_PROTOCOL_LIMITS: DshProtocolLimits = Object.freeze({
  maxFrameBytes: 1_048_576,
  maxPendingRequests: 128,
  maxConcurrentReverseRequests: 32,
  maxAttachmentLeases: 128,
  eventQueueHighWatermark: 2_048,
});

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("DSH execution authority contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (!value || typeof value !== "object") {
    throw new Error("DSH execution authority is not canonical JSON");
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => {
      if (record[key] === undefined) {
        throw new Error("DSH execution authority contains undefined");
      }
      return `${JSON.stringify(key)}:${canonicalJson(record[key])}`;
    })
    .join(",")}}`;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    deepFreeze(entry);
  }
  return Object.freeze(value);
}

function validateExecutionEnvironment(
  environment: Omit<DshExecutionEnvironment, "digest">,
  workspace: { path: string; identity: string },
  runtimeHome: string,
): void {
  const forbiddenKey =
    /(api.?key|authorization|credential|password|secret|token|cookie|proxy)/i;
  if (
    !isAbsolute(workspace.path) ||
    !isAbsolute(runtimeHome) ||
    !isAbsolute(environment.workspace.canonicalRoot) ||
    !isAbsolute(environment.attachmentStagingRoot) ||
    environment.workspace.identity !== workspace.identity ||
    normalize(environment.workspace.canonicalRoot) !==
      normalize(workspace.path) ||
    environment.environment.secretValues !== "reverse-port-only" ||
    [
      ...environment.environment.allowedKeys,
      ...environment.environment.inheritedKeys,
    ].some((key) => forbiddenKey.test(key))
  ) {
    throw new Error("DSH execution environment authority is invalid");
  }
}

export function createDshInitializeParams(options: {
  productSessionId: string;
  productVersion: string;
  runtimeHome: string;
  workspace: Readonly<{ path: string; identity: string }>;
  executionEnvironment: Omit<DshExecutionEnvironment, "digest">;
  interaction: "interactive" | "deterministic-headless" | "unavailable";
  webSearchAdapters?: readonly string[];
  limits?: DshProtocolLimits;
  platform?: string;
  arch?: string;
}): DshInitializeParams {
  const executionEnvironment = structuredClone(options.executionEnvironment);
  validateExecutionEnvironment(
    executionEnvironment,
    options.workspace,
    options.runtimeHome,
  );
  const digest = createHash("sha256")
    .update(canonicalJson(executionEnvironment))
    .digest("hex");
  return deepFreeze({
    protocol: {
      minVersion: "2.0.0",
      maxVersion: "2.0.0",
    },
    host: {
      name: "MyAgents",
      version: options.productVersion,
      platform: options.platform ?? process.platform,
      arch: options.arch ?? process.arch,
      nodeVersion: `v${dshLock.runtime.requiredNodeVersion}`,
    },
    productSessionId: options.productSessionId,
    runtimeHome: normalize(options.runtimeHome),
    workspace: {
      path: normalize(options.workspace.path),
      identity: options.workspace.identity,
    },
    executionEnvironment: {
      ...executionEnvironment,
      digest,
    },
    hostCapabilities: {
      interaction: options.interaction,
      attachments: "generation-leases-v1",
      productProjection: "transactional-postconditions-v1",
      credentialAuthority: "revisioned-reverse-port-v1",
      webSearchAdapters: [...(options.webSearchAdapters ?? [])],
    },
    limits: { ...(options.limits ?? DSH_DEFAULT_PROTOCOL_LIMITS) },
  });
}
