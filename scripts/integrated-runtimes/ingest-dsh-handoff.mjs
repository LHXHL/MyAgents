#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  compareOrAcceptContracts,
  parseNamedArgs,
  resolveExplicitDirectory,
  runPublicVerifier,
  stageCompleteHandoff,
  verifyBundledToolchain,
  verifyHandoffFacts,
} from "./dsh-handoff-policy.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const args = parseNamedArgs(process.argv.slice(2), {
  "--handoff": "value",
  "--out": "value",
  "--node-root": "value",
  "--accept-contracts": "boolean",
});
const handoffRoot = resolveExplicitDirectory(args["--handoff"], "--handoff");
const outputRoot = resolve(
  args["--out"] ??
    resolve(repoRoot, "src-tauri/resources/integrated-runtimes/dsh"),
);
const lock = JSON.parse(
  readFileSync(
    resolve(repoRoot, "src/shared/integrated-runtimes/dsh-lock.json"),
    "utf8",
  ),
);
const { nodeExecutable } = verifyBundledToolchain(repoRoot, lock, args["--node-root"]);
runPublicVerifier(handoffRoot, lock.handoff.manifestSha256, nodeExecutable);
const verified = verifyHandoffFacts(handoffRoot, lock);
compareOrAcceptContracts(
  handoffRoot,
  resolve(repoRoot, "contracts"),
  args["--accept-contracts"] === true,
);
stageCompleteHandoff(handoffRoot, outputRoot, (stagedRoot) => {
  runPublicVerifier(stagedRoot, lock.handoff.manifestSha256, nodeExecutable);
  verifyHandoffFacts(stagedRoot, lock);
  compareOrAcceptContracts(stagedRoot, resolve(repoRoot, "contracts"), false);
});

process.stdout.write(
  `${JSON.stringify({ ...verified, outputRoot }, null, 2)}\n`,
);
