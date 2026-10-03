import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveDshRuntimeInstallation } from "./installation";

describe("DSH Runtime installation paths", () => {
  it("resolves the artifact entrypoint and bundled Node without verifying the handoff", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "dsh-install-")));
    const dshRoot = join(root, "integrated-runtimes/dsh");
    const artifactRoot = join(dshRoot, "runtime-artifact");
    const nodePath = join(root, "nodejs/bin/node");
    await Promise.all([
      mkdir(artifactRoot, { recursive: true }),
      mkdir(join(root, "nodejs/bin"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(artifactRoot, "runtime-server-process.artifact.mjs"),
        "export {};\n",
      ),
      writeFile(join(artifactRoot, "package.json"), "{}\n"),
      writeFile(nodePath, "placeholder\n"),
    ]);
    try {
      await expect(
        resolveDshRuntimeInstallation({
          resourceRoot: root,
          nodeExecutablePath: nodePath,
        }),
      ).resolves.toMatchObject({
        resourceRoot: root,
        dshResourceRoot: dshRoot,
        runtimeArtifactRoot: artifactRoot,
        nodeExecutablePath: nodePath,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
