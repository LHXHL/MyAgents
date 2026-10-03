#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  compareOrAcceptContracts,
  parseNamedArgs,
  resolveExplicitDirectory,
  runPublicVerifier,
  assertBundledNodeRequirement,
  verifyHandoffFacts,
} from "./dsh-handoff-policy.mjs";
import { readDshBuildSelection } from "./dsh-build-selection.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const args = parseNamedArgs(process.argv.slice(2), {
  "--runtime-root": "value",
});
const runtimeRoot = resolveExplicitDirectory(
  resolve(
    args["--runtime-root"] ??
      resolve(repoRoot, "src-tauri/resources/integrated-runtimes/dsh"),
  ),
  "--runtime-root",
);
const releaseLock = JSON.parse(
  readFileSync(
    resolve(repoRoot, "src/shared/integrated-runtimes/dsh-lock.json"),
    "utf8",
  ),
);
const selection = readDshBuildSelection(repoRoot);
const lock = selection?.lock ?? releaseLock;
assertBundledNodeRequirement(repoRoot, lock);
runPublicVerifier(runtimeRoot, lock.handoff.manifestSha256);
const verified = verifyHandoffFacts(runtimeRoot, lock);
if (selection?.source !== "release") {
  compareOrAcceptContracts(runtimeRoot, resolve(repoRoot, "contracts"), false,
    selection ? ["contracts/myagents-dsh-compatibility-v1.json"] : []);
}

process.stdout.write(`${JSON.stringify({ source: selection?.source ?? "release", ...verified }, null, 2)}\n`);
