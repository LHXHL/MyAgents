import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

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
