import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { isAbsolute, join, resolve, sep } from "node:path";

import dshLock from "../../../shared/integrated-runtimes/dsh-lock.json";
import type { DshChildEnvironment } from "./child-environment";
import {
  DSH_GENERATED_CAPABILITY_PROFILE_DIGEST,
  DSH_HOST_METHOD_NAMES,
  DSH_NOTIFICATION_NAMES,
  DSH_REVERSE_METHOD_NAMES,
} from "./protocol-types";

const execFileAsync = promisify(execFile);
const acceptedHandoffs = new Map<string, Promise<void>>();

export type DshRuntimeInstallation = Readonly<{
  resourceRoot: string;
  dshResourceRoot: string;
  handoffVerifierPath: string;
  runtimeArtifactRoot: string;
  runtimeEntrypointPath: string;
  nodeExecutablePath: string;
}>;

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

async function regularFile(path: string, description: string): Promise<void> {
  const details = await stat(path);
  if (!details.isFile())
    throw new Error(`${description} is not a regular file`);
}

export async function resolveDshRuntimeInstallation(options: {
  resourceRoot: string;
  nodeExecutablePath: string;
}): Promise<DshRuntimeInstallation> {
  if (
    !isAbsolute(options.resourceRoot) ||
    !isAbsolute(options.nodeExecutablePath)
  ) {
    throw new Error("DSH Runtime installation paths must be absolute");
  }
  const requestedResourceRoot = resolve(options.resourceRoot);
  const requestedDshRoot = join(requestedResourceRoot, dshLock.resourcePath);
  const requestedArtifactRoot = join(requestedDshRoot, "runtime-artifact");
  const requestedHandoffVerifier = join(requestedDshRoot, "verify.mjs");
  const requestedEntrypoint = join(
    requestedArtifactRoot,
    dshLock.runtime.entrypoint,
  );
  const [
    resourceRoot,
    dshResourceRoot,
    runtimeArtifactRoot,
    handoffVerifier,
    entrypoint,
    node,
  ] = await Promise.all([
    realpath(requestedResourceRoot),
    realpath(requestedDshRoot),
    realpath(requestedArtifactRoot),
    realpath(requestedHandoffVerifier),
    realpath(requestedEntrypoint),
    realpath(options.nodeExecutablePath),
  ]);
  if (
    !isInside(resourceRoot, dshResourceRoot) ||
    !isInside(dshResourceRoot, runtimeArtifactRoot) ||
    !isInside(dshResourceRoot, handoffVerifier) ||
    !isInside(runtimeArtifactRoot, entrypoint) ||
    !isInside(resourceRoot, node) ||
    entrypoint !== join(runtimeArtifactRoot, dshLock.runtime.entrypoint)
  ) {
    throw new Error(
      "DSH Runtime installation escaped its verified resource root",
    );
  }
  await Promise.all([
    regularFile(handoffVerifier, "DSH handoff verifier"),
    regularFile(entrypoint, "DSH Runtime entrypoint"),
    regularFile(node, "DSH bundled Node executable"),
    regularFile(
      join(runtimeArtifactRoot, "package.json"),
      "DSH Runtime package manifest",
    ),
  ]);
  return Object.freeze({
    resourceRoot,
    dshResourceRoot,
    handoffVerifierPath: handoffVerifier,
    runtimeArtifactRoot,
    runtimeEntrypointPath: entrypoint,
    nodeExecutablePath: node,
  });
}

async function runDshHandoffVerification(
  installation: DshRuntimeInstallation,
  childEnvironment: DshChildEnvironment,
): Promise<void> {
  const { stdout } = await execFileAsync(
    installation.nodeExecutablePath,
    [installation.handoffVerifierPath, dshLock.handoff.manifestSha256],
    {
      cwd: installation.dshResourceRoot,
      env: childEnvironment.env,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 2 * 1_048_576,
      windowsHide: true,
    },
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("DSH handoff verifier did not return JSON");
  }
  const report = reportObject(parsed, "DSH handoff verifier report");
  if (
    report.kind !== "myagents-dsh-batch-3-integration-handoff" ||
    report.runtimeManifestSha256 !== dshLock.handoff.runtimeManifestSha256 ||
    report.compatibilitySha256 !== dshLock.handoff.compatibilitySha256 ||
    !Number.isSafeInteger(report.files) ||
    (report.files as number) < 1
  ) {
    throw new Error("DSH handoff verifier report differs from the lock");
  }
  assertDshSelfCheckReport(report.selfCheck);
}

/** Verify the complete outer handoff once per Sidecar process. */
export function assertDshHandoffVerification(
  installation: DshRuntimeInstallation,
  childEnvironment: DshChildEnvironment,
): Promise<void> {
  const key = `${installation.nodeExecutablePath}\u0000${installation.handoffVerifierPath}`;
  const existing = acceptedHandoffs.get(key);
  if (existing) return existing;
  const check = runDshHandoffVerification(installation, childEnvironment).catch(
    (error) => {
      acceptedHandoffs.delete(key);
      throw error;
    },
  );
  acceptedHandoffs.set(key, check);
  return check;
}

function reportObject(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} is invalid`);
  }
  return value as Record<string, unknown>;
}

function sameStringSet(value: unknown, expected: readonly string[]): boolean {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    return false;
  }
  const strings = value as string[];
  return (
    strings.length === expected.length &&
    new Set(strings).size === expected.length &&
    expected.every((entry) => strings.includes(entry))
  );
}

function assertDshSelfCheckReport(parsed: unknown): void {
  const report = reportObject(parsed, "DSH Runtime self-check report");
  const runtime = reportObject(
    report.runtime,
    "DSH Runtime self-check identity",
  );
  const dsh = reportObject(report.dsh, "DSH self-check engine identity");
  const protocol = reportObject(report.protocol, "DSH self-check protocol");
  const profile = reportObject(report.profile, "DSH self-check profile");
  const platform = reportObject(report.platform, "DSH self-check platform");
  if (
    report.formatVersion !== 1 ||
    report.mode !== "self-check" ||
    runtime.version !== dshLock.runtime.version ||
    runtime.requiredNodeVersion !== dshLock.runtime.requiredNodeVersion ||
    runtime.actualNodeVersion !== dshLock.runtime.requiredNodeVersion ||
    runtime.artifactManifestSha256 !== dshLock.handoff.runtimeManifestSha256 ||
    runtime.repositoryHead !== dshLock.handoff.sourceCommit ||
    dsh.artifactVersion !== dshLock.dsh.version ||
    dsh.artifactManifestSha256 !== dshLock.dsh.artifactManifestSha256 ||
    dsh.sourceCommit !== dshLock.dsh.sourceCommit ||
    dsh.patchSeriesSha256 !== dshLock.dsh.patchSeriesSha256 ||
    protocol.version !== dshLock.protocol.version ||
    protocol.schemaSha256 !== dshLock.protocol.schemaSha256 ||
    protocol.sessionFormat !== dshLock.runtime.sessionFormat ||
    protocol.capabilityProfileDigest !==
      DSH_GENERATED_CAPABILITY_PROFILE_DIGEST ||
    !sameStringSet(protocol.availableHostMethods, DSH_HOST_METHOD_NAMES) ||
    !sameStringSet(
      protocol.availableReverseMethods,
      DSH_REVERSE_METHOD_NAMES,
    ) ||
    !sameStringSet(protocol.availableNotifications, DSH_NOTIFICATION_NAMES) ||
    profile.id !== dshLock.profile.id ||
    profile.digest !== dshLock.profile.digest ||
    typeof platform.target !== "string" ||
    !dshLock.platforms.some((claim) => claim.target === platform.target)
  ) {
    throw new Error("DSH Runtime self-check report differs from the lock");
  }
}
