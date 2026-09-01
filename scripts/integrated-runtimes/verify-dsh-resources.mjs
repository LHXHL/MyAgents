#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertProviderCellContractFacts,
  compareOrAcceptContracts,
  parseNamedArgs,
  resolveExplicitDirectory,
  runPublicVerifier,
  verifyHandoffFacts,
} from "./dsh-handoff-policy.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const args = parseNamedArgs(process.argv.slice(2), {
  "--runtime-root": "value",
  "--node-root": "value",
  "--skip-node": "boolean",
});
const runtimeRoot = resolveExplicitDirectory(
  resolve(
    args["--runtime-root"] ??
      resolve(repoRoot, "src-tauri/resources/integrated-runtimes/dsh"),
  ),
  "--runtime-root",
);
const lock = JSON.parse(
  readFileSync(
    resolve(repoRoot, "src/shared/integrated-runtimes/dsh-lock.json"),
    "utf8",
  ),
);
const providerCells = JSON.parse(
  readFileSync(
    resolve(
      repoRoot,
      "src/shared/integrated-runtimes/dsh-provider-cells-v1.json",
    ),
    "utf8",
  ),
);

runPublicVerifier(runtimeRoot, lock.handoff.manifestSha256);
const verified = verifyHandoffFacts(runtimeRoot, lock);
compareOrAcceptContracts(runtimeRoot, resolve(repoRoot, "contracts"), false);
assertProviderCellContractFacts(providerCells, lock);

if (args["--skip-node"] !== true) {
  const nodeRoot = resolveExplicitDirectory(
    resolve(
      args["--node-root"] ?? resolve(repoRoot, "src-tauri/resources/nodejs"),
    ),
    "--node-root",
  );
  const nodeVersionPath = resolve(nodeRoot, ".myagents-nodejs-version");
  const npmVersionPath = resolve(nodeRoot, ".myagents-npm-version");
  const platformPath = resolve(nodeRoot, ".myagents-nodejs-platform");
  for (const path of [nodeVersionPath, npmVersionPath, platformPath]) {
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      throw new Error(
        `[dsh-handoff] bundled toolchain metadata is missing: ${path}`,
      );
    }
  }
  const nodeVersion = readFileSync(nodeVersionPath, "utf8").trim();
  const npmVersion = readFileSync(npmVersionPath, "utf8").trim();
  const platform = readFileSync(platformPath, "utf8").trim();
  if (nodeVersion !== lock.runtime.requiredNodeVersion) {
    throw new Error(
      `[dsh-handoff] bundled Node mismatch: expected ${lock.runtime.requiredNodeVersion}, received ${nodeVersion}`,
    );
  }
  if (npmVersion !== lock.bundledNpm.version) {
    throw new Error(
      `[dsh-handoff] bundled npm mismatch: expected ${lock.bundledNpm.version}, received ${npmVersion}`,
    );
  }
  const nodeExecutable = resolve(
    nodeRoot,
    platform === "win" ? "node.exe" : "bin/node",
  );
  const npmCli = resolve(
    nodeRoot,
    platform === "win"
      ? "node_modules/npm/bin/npm-cli.js"
      : "lib/node_modules/npm/bin/npm-cli.js",
  );
  for (const path of [nodeExecutable, npmCli]) {
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      throw new Error(
        `[dsh-handoff] bundled toolchain file is missing: ${path}`,
      );
    }
  }
  const executedNodeVersion = execFileSync(nodeExecutable, ["--version"], {
    encoding: "utf8",
  })
    .trim()
    .replace(/^v/, "");
  const executedNpmVersion = execFileSync(
    nodeExecutable,
    [npmCli, "--version"],
    {
      encoding: "utf8",
    },
  ).trim();
  if (executedNodeVersion !== lock.runtime.requiredNodeVersion) {
    throw new Error(
      `[dsh-handoff] bundled Node executable mismatch: expected ${lock.runtime.requiredNodeVersion}, received ${executedNodeVersion}`,
    );
  }
  if (executedNpmVersion !== lock.bundledNpm.version) {
    throw new Error(
      `[dsh-handoff] bundled npm executable mismatch: expected ${lock.bundledNpm.version}, received ${executedNpmVersion}`,
    );
  }
  verified.bundledNodeVersion = nodeVersion;
  verified.bundledNpmVersion = npmVersion;
}

process.stdout.write(`${JSON.stringify(verified, null, 2)}\n`);
