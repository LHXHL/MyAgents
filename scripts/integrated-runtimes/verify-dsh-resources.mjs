#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  compareOrAcceptContracts,
  parseNamedArgs,
  resolveExplicitDirectory,
  runPublicVerifier,
  verifyBundledToolchain,
  verifyHandoffFacts,
} from "./dsh-handoff-policy.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const args = parseNamedArgs(process.argv.slice(2), {
  "--runtime-root": "value",
  "--node-root": "value",
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
const { nodeExecutable, ...toolchain } = verifyBundledToolchain(repoRoot, lock, args["--node-root"]);
runPublicVerifier(runtimeRoot, lock.handoff.manifestSha256, nodeExecutable);
const verified = verifyHandoffFacts(runtimeRoot, lock);
compareOrAcceptContracts(runtimeRoot, resolve(repoRoot, "contracts"), false);

process.stdout.write(`${JSON.stringify({ ...verified, ...toolchain }, null, 2)}\n`);
