import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import type { IntegratedRuntimeArtifactIdentity } from "../../../shared/types/runtime";

import dshLock from "../../../shared/integrated-runtimes/effective-dsh-lock";

export type DshRuntimeInstallation = Readonly<{
  resourceRoot: string;
  dshResourceRoot: string;
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
  const requestedEntrypoint = join(
    requestedArtifactRoot,
    dshLock.runtime.entrypoint,
  );
  const [
    resourceRoot,
    dshResourceRoot,
    runtimeArtifactRoot,
    entrypoint,
    node,
  ] = await Promise.all([
    realpath(requestedResourceRoot),
    realpath(requestedDshRoot),
    realpath(requestedArtifactRoot),
    realpath(requestedEntrypoint),
    realpath(options.nodeExecutablePath),
  ]);
  if (
    !isInside(resourceRoot, dshResourceRoot) ||
    !isInside(dshResourceRoot, runtimeArtifactRoot) ||
    !isInside(runtimeArtifactRoot, entrypoint) ||
    !isInside(resourceRoot, node) ||
    entrypoint !== join(runtimeArtifactRoot, dshLock.runtime.entrypoint)
  ) {
    throw new Error(
      "DSH Runtime installation escaped its verified resource root",
    );
  }
  await Promise.all([
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
    runtimeArtifactRoot,
    runtimeEntrypointPath: entrypoint,
    nodeExecutablePath: node,
  });
}

/** Read existing identity manifests for diagnostics only; never gate execution. */
export async function inspectDshRuntimeArtifactIdentity(
  installation: DshRuntimeInstallation,
): Promise<IntegratedRuntimeArtifactIdentity | null> {
  try {
    const [handoffPath, runtimePath] = await Promise.all([
      realpath(join(installation.dshResourceRoot, "batch-3-integration-handoff-v1.json")),
      realpath(join(installation.runtimeArtifactRoot, "runtime-artifact-v1.json")),
    ]);
    if (!isInside(installation.dshResourceRoot, handoffPath)
      || !isInside(installation.runtimeArtifactRoot, runtimePath)) return null;
    const [handoffBytes, runtimeBytes] = await Promise.all([readFile(handoffPath), readFile(runtimePath)]);
    const manifest = JSON.parse(runtimeBytes.toString("utf8")) as {
      runtimeVersion?: unknown;
      dsh?: { artifactVersion?: unknown };
      build?: { repositoryHead?: unknown; toolchain?: { node?: unknown } };
    } | null;
    const runtimeVersion = manifest?.runtimeVersion;
    const dshVersion = manifest?.dsh?.artifactVersion;
    const sourceCommit = manifest?.build?.repositoryHead;
    const requiredNodeVersion = manifest?.build?.toolchain?.node;
    if (typeof runtimeVersion !== "string" || !runtimeVersion
      || typeof dshVersion !== "string" || !dshVersion
      || typeof sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(sourceCommit)
      || typeof requiredNodeVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(requiredNodeVersion)) return null;
    // The handoff is also a JSON manifest. Missing/damaged metadata stays unknown.
    const handoff = JSON.parse(handoffBytes.toString("utf8")) as {
      runtime?: { path?: unknown; manifestSha256?: unknown };
    } | null;
    if (handoff?.runtime?.path !== "runtime-artifact"
      || typeof handoff.runtime.manifestSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(handoff.runtime.manifestSha256)) return null;
    return {
      runtimeVersion, dshVersion, sourceCommit, requiredNodeVersion,
      handoffSha256: createHash("sha256").update(handoffBytes).digest("hex"),
      runtimeManifestSha256: createHash("sha256").update(runtimeBytes).digest("hex"),
    };
  } catch {
    return null;
  }
}
