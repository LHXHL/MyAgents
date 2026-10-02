import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, sep } from "node:path";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import dshLock from "../../../shared/integrated-runtimes/effective-dsh-lock";
import {
  DSH_CLIENT_METHOD_BY_PROTOCOL,
  DSH_CANONICAL_WEB_POLICY_REF,
  DSH_GENERATED_CAPABILITY_PROFILE_DIGEST,
  DSH_HOST_METHOD_NAMES,
  type DshGeneratedHostClient,
  type DshJsonRpcPeer,
  type DshProtocolErrorConstructor,
  type DshProtocolLimits,
} from "./protocol-types";

type JsonRpcPeerConstructor = new (options: {
  input: Readable;
  output: Writable;
  role: "host";
  limits: DshProtocolLimits;
  onFatalError?: (error: Error) => void;
}) => DshJsonRpcPeer;

type GeneratedHostClientConstructor = new (
  peer: DshJsonRpcPeer,
) => DshGeneratedHostClient;

export type LoadedDshProtocolRuntime = Readonly<{
  protocolEntryPath: string;
  generatedClientEntryPath: string;
  ProtocolError: DshProtocolErrorConstructor;
  createHostClient: (options: {
    input: Readable;
    output: Writable;
    limits: DshProtocolLimits;
    onFatalError?: (error: Error) => void;
  }) => DshGeneratedHostClient;
}>;

function moduleRecord(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`${description} did not expose an ES module namespace`);
  }
  return value as Record<string, unknown>;
}

async function assertPublicEntryInsideArtifact(
  artifactRoot: string,
  entryPath: string,
): Promise<string> {
  const [root, entry] = await Promise.all([
    realpath(artifactRoot),
    realpath(entryPath),
  ]);
  if (entry !== root && !entry.startsWith(`${root}${sep}`)) {
    throw new Error("DSH public protocol export escaped the Runtime artifact");
  }
  return entry;
}

function assertGeneratedClientSurface(
  GeneratedHostClient: GeneratedHostClientConstructor,
): void {
  const prototype = GeneratedHostClient.prototype as unknown as Record<
    string,
    unknown
  >;
  for (const method of DSH_HOST_METHOD_NAMES) {
    const clientMethod = DSH_CLIENT_METHOD_BY_PROTOCOL[method];
    if (typeof prototype[clientMethod] !== "function") {
      throw new Error(`DSH generated Host client is missing ${method}`);
    }
  }
  for (const method of [
    "initialized",
    "registerHostHandlers",
    "registerRuntimeNotificationHandlers",
  ]) {
    if (typeof prototype[method] !== "function") {
      throw new Error(`DSH generated Host client is missing ${method}`);
    }
  }
}

/**
 * Load only the protocol package's public exports from the already verified
 * Runtime artifact. The checked-in generated TypeScript remains the diff/hash
 * authority; execution uses the matching generated JavaScript and validators
 * shipped inside that immutable artifact.
 */
export async function loadDshProtocolRuntime(
  runtimeArtifactRoot: string,
): Promise<LoadedDshProtocolRuntime> {
  const absoluteArtifactRoot = resolve(runtimeArtifactRoot);
  const requireFromArtifact = createRequire(
    resolve(absoluteArtifactRoot, "package.json"),
  );
  const [rawProtocolEntry, rawGeneratedClientEntry] = await Promise.all([
    Promise.resolve(requireFromArtifact.resolve("@myagents-dsh/protocol")),
    Promise.resolve(
      requireFromArtifact.resolve(
        "@myagents-dsh/protocol/generated/host-client",
      ),
    ),
  ]);
  const [protocolEntryPath, generatedClientEntryPath] = await Promise.all([
    assertPublicEntryInsideArtifact(absoluteArtifactRoot, rawProtocolEntry),
    assertPublicEntryInsideArtifact(
      absoluteArtifactRoot,
      rawGeneratedClientEntry,
    ),
  ]);
  const [protocolModuleValue, generatedModuleValue] = await Promise.all([
    import(pathToFileURL(protocolEntryPath).href),
    import(pathToFileURL(generatedClientEntryPath).href),
  ]);
  const protocolModule = moduleRecord(protocolModuleValue, "DSH protocol");
  const generatedModule = moduleRecord(
    generatedModuleValue,
    "DSH generated Host client",
  );

  if (
    generatedModule.GENERATED_PROTOCOL_VERSION !== dshLock.protocol.version ||
    generatedModule.GENERATED_SCHEMA_SHA256 !== dshLock.protocol.schemaSha256 ||
    generatedModule.GENERATED_CAPABILITY_PROFILE_DIGEST !==
      DSH_GENERATED_CAPABILITY_PROFILE_DIGEST
  ) {
    throw new Error("DSH generated Host client identity differs from the lock");
  }
  if (protocolModule.DEEPSEEK_WEB_SEARCH_POLICY_REF !== DSH_CANONICAL_WEB_POLICY_REF) {
    throw new Error("DSH canonical Web policy differs from the integrated Host policy");
  }

  const JsonRpcPeer = protocolModule.JsonRpcPeer as
    | JsonRpcPeerConstructor
    | undefined;
  const ProtocolError = protocolModule.ProtocolError as
    | DshProtocolErrorConstructor
    | undefined;
  const GeneratedHostClient = generatedModule.GeneratedHostClient as
    | GeneratedHostClientConstructor
    | undefined;
  if (!JsonRpcPeer || !ProtocolError || !GeneratedHostClient) {
    throw new Error("DSH public protocol exports are incomplete");
  }
  assertGeneratedClientSurface(GeneratedHostClient);

  return Object.freeze({
    protocolEntryPath,
    generatedClientEntryPath,
    ProtocolError,
    createHostClient: (options) => {
      const peer = new JsonRpcPeer({
        input: options.input,
        output: options.output,
        role: "host",
        limits: options.limits,
        ...(options.onFatalError ? { onFatalError: options.onFatalError } : {}),
      });
      return new GeneratedHostClient(peer);
    },
  });
}
