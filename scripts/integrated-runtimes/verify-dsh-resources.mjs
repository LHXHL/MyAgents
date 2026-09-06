#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
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
runPublicVerifier(runtimeRoot, lock.handoff.manifestSha256);
const verified = verifyHandoffFacts(runtimeRoot, lock);
compareOrAcceptContracts(runtimeRoot, resolve(repoRoot, "contracts"), false);

if (args["--skip-node"] !== true) {
  const nodeRoot = resolveExplicitDirectory(
    resolve(
      args["--node-root"] ?? resolve(repoRoot, "src-tauri/resources/nodejs"),
    ),
    "--node-root",
  );
  const nodeVersionPath = resolve(nodeRoot, ".myagents-nodejs-version");
  const platformPath = resolve(nodeRoot, ".myagents-nodejs-platform");
  for (const path of [nodeVersionPath, platformPath]) {
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      throw new Error(
        `[dsh-handoff] bundled toolchain metadata is missing: ${path}`,
      );
    }
  }
  const nodeVersion = readFileSync(nodeVersionPath, "utf8").trim();
  const platform = readFileSync(platformPath, "utf8").trim();
  const npmPackagePath = resolve(nodeRoot, platform === "win"
    ? "node_modules/npm/package.json" : "lib/node_modules/npm/package.json");
  if (!existsSync(npmPackagePath) || !lstatSync(npmPackagePath).isFile()) {
    throw new Error(`[dsh-handoff] bundled npm package is missing: ${npmPackagePath}`);
  }
  const npmVersion = JSON.parse(readFileSync(npmPackagePath, "utf8")).version;
  const distribution = JSON.parse(readFileSync(resolve(repoRoot, "scripts/node-runtime.json"), "utf8"));
  if (distribution.node !== lock.runtime.requiredNodeVersion || distribution.npm !== lock.bundledNpm.version) {
    throw new Error("[dsh-handoff] Runtime lock differs from the official bundled Node/npm distribution");
  }
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
