import releaseCompatibility from "../../../contracts/myagents-dsh/myagents-dsh-compatibility-v1.json";
import dshLock from "./effective-dsh-lock";

declare const __MYAGENTS_DSH_BUILD_COMPATIBILITY__: typeof releaseCompatibility | undefined;
const compatibilityJson = typeof __MYAGENTS_DSH_BUILD_COMPATIBILITY__ === "undefined"
  ? releaseCompatibility
  : __MYAGENTS_DSH_BUILD_COMPATIBILITY__;
import type { DshApiFamily } from "./provider-constraints";

const DSH_API_FAMILIES = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
] as const satisfies readonly DshApiFamily[];

const REQUIRED_LIMITATIONS = [
  "stop-sequences-unsupported-on-pi-ai",
  "catalog-is-advisory",
  "native-cloud-and-oauth-auth-unadvertised",
  "pi-ai-reasoning-token-usage-unavailable",
  "canonical-web-route-dependent",
  "checkpoint-coverage",
] as const;

export type DshApiFamilyCompatibility = Readonly<{
  id: DshApiFamily;
  adapter: string;
  piAiVersion: string;
  compatibilityProfileVersion: 1;
  credentialMode: "request-scoped-api-key";
  routeAdmission: "host-declared-api-family";
  modelCapabilities: "host-profile";
  webBackend: "route-dependent";
  liveApply: "next-turn";
  deterministicEvidence: readonly (
    | "reasoning"
    | "stream"
    | "terminal"
    | "text"
    | "tool-call"
    | "usage"
  )[];
}>;

export type DshCompatibilityManifest = Readonly<{
  schemaVersion: 1;
  apiFamilies: readonly DshApiFamilyCompatibility[];
  limitationIds: ReadonlySet<string>;
}>;

function record(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactString(
  value: unknown,
  expected: string,
  description: string,
): void {
  if (value !== expected) {
    throw new Error(`${description} does not match the committed DSH lock`);
  }
}

export function parseDshCompatibilityManifest(
  value: unknown,
): DshCompatibilityManifest {
  const root = record(value, "DSH compatibility manifest");
  if (root.schemaVersion !== 1) {
    throw new Error("DSH compatibility schemaVersion must be 1");
  }

  const runtime = record(root.runtime, "DSH compatibility runtime identity");
  exactString(runtime.version, dshLock.runtime.version, "Runtime version");
  exactString(
    runtime.artifactSha256,
    dshLock.handoff.runtimeManifestSha256,
    "Runtime artifact digest",
  );
  exactString(
    runtime.entrypoint,
    dshLock.runtime.entrypoint,
    "Runtime entrypoint",
  );
  exactString(
    runtime.sessionFormat,
    dshLock.runtime.sessionFormat,
    "Session format",
  );
  exactString(runtime.profileId, dshLock.profile.id, "Runtime profile id");
  exactString(
    runtime.profileDigest,
    dshLock.profile.digest,
    "Runtime profile digest",
  );

  const protocol = record(root.protocol, "DSH compatibility protocol identity");
  exactString(protocol.version, dshLock.protocol.version, "Protocol version");
  exactString(
    protocol.schemaSha256,
    dshLock.protocol.schemaSha256,
    "Protocol schema digest",
  );
  exactString(
    protocol.generatedClientSha256,
    dshLock.handoff.generatedClientSha256,
    "Generated client digest",
  );

  const dsh = record(root.dsh, "DSH engine identity");
  exactString(dsh.version, dshLock.dsh.version, "DSH version");
  exactString(dsh.sourceCommit, dshLock.dsh.sourceCommit, "DSH source commit");
  exactString(
    dsh.patchSeriesSha256,
    dshLock.dsh.patchSeriesSha256,
    "DSH patch digest",
  );
  exactString(
    dsh.artifactManifestSha256,
    dshLock.dsh.artifactManifestSha256,
    "DSH artifact digest",
  );

  if (!Array.isArray(root.apiFamilies)) {
    throw new Error("DSH compatibility apiFamilies must be an array");
  }
  const families = root.apiFamilies.map((entry): DshApiFamilyCompatibility => {
    const family = record(entry, "DSH API-family declaration");
    if (!DSH_API_FAMILIES.includes(family.id as DshApiFamily)) {
      throw new Error(`Unsupported DSH API family ${String(family.id)}`);
    }
    if (
      typeof family.adapter !== "string" ||
      !family.adapter.startsWith("@deepseek-ai/dsh-llm-pi-ai@") ||
      typeof family.piAiVersion !== "string" ||
      family.compatibilityProfileVersion !== 1 ||
      family.credentialMode !== "request-scoped-api-key" ||
      family.routeAdmission !== "host-declared-api-family" ||
      family.modelCapabilities !== "host-profile" ||
      family.webBackend !== "route-dependent" ||
      family.liveApply !== "next-turn" ||
      !Array.isArray(family.deterministicEvidence)
    ) {
      throw new Error(
        `Invalid compatibility declaration for ${String(family.id)}`,
      );
    }
    const evidence = family.deterministicEvidence;
    const expectedEvidence = [
      "reasoning",
      "stream",
      "terminal",
      "text",
      "tool-call",
      "usage",
    ];
    if (
      evidence.length !== expectedEvidence.length ||
      expectedEvidence.some((fact) => !evidence.includes(fact))
    ) {
      throw new Error(
        `Incomplete deterministic evidence for ${String(family.id)}`,
      );
    }
    return Object.freeze({
      id: family.id as DshApiFamily,
      adapter: family.adapter,
      piAiVersion: family.piAiVersion,
      compatibilityProfileVersion: 1,
      credentialMode: "request-scoped-api-key",
      routeAdmission: "host-declared-api-family",
      modelCapabilities: "host-profile",
      webBackend: "route-dependent",
      liveApply: "next-turn",
      deterministicEvidence: Object.freeze([
        ...evidence,
      ]) as DshApiFamilyCompatibility["deterministicEvidence"],
    });
  });
  if (
    families.length !== DSH_API_FAMILIES.length ||
    DSH_API_FAMILIES.some(
      (id) => families.filter((family) => family.id === id).length !== 1,
    )
  ) {
    throw new Error(
      "DSH compatibility must declare each accepted API family once",
    );
  }

  if (!Array.isArray(root.limitations)) {
    throw new Error("DSH compatibility limitations must be an array");
  }
  const limitationIds = new Set(
    root.limitations.map((entry) => {
      const limitation = record(entry, "DSH compatibility limitation");
      if (
        typeof limitation.id !== "string" ||
        typeof limitation.statement !== "string"
      ) {
        throw new Error("DSH compatibility limitation is invalid");
      }
      return limitation.id;
    }),
  );
  for (const id of REQUIRED_LIMITATIONS) {
    if (!limitationIds.has(id)) {
      throw new Error(`DSH compatibility limitation ${id} is missing`);
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    apiFamilies: Object.freeze(families),
    limitationIds,
  });
}

export const DSH_COMPATIBILITY =
  parseDshCompatibilityManifest(compatibilityJson);

export function getDshApiFamilyCompatibility(
  apiFamily: DshApiFamily,
): DshApiFamilyCompatibility {
  const declaration = DSH_COMPATIBILITY.apiFamilies.find(
    (candidate) => candidate.id === apiFamily,
  );
  if (!declaration)
    throw new Error(`DSH API family ${apiFamily} is not compatible`);
  return declaration;
}
