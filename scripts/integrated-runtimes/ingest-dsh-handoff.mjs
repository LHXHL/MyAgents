#!/usr/bin/env node

import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import {
  compareOrAcceptContracts,
  parseNamedArgs,
  resolveExplicitDirectory,
  runPublicVerifier,
  stageCompleteHandoff,
  assertBundledNodeRequirement,
  verifyHandoffFacts,
} from "./dsh-handoff-policy.mjs";
import { buildSelectionPath } from "./dsh-build-selection.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const args = parseNamedArgs(process.argv.slice(2), {
  "--handoff": "value",
  "--out": "value",
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
assertBundledNodeRequirement(repoRoot, lock);
runPublicVerifier(handoffRoot, lock.handoff.manifestSha256);
const verified = verifyHandoffFacts(handoffRoot, lock);
compareOrAcceptContracts(
  handoffRoot,
  resolve(repoRoot, "contracts"),
  args["--accept-contracts"] === true,
);
stageCompleteHandoff(handoffRoot, outputRoot, (stagedRoot) => {
  runPublicVerifier(stagedRoot, lock.handoff.manifestSha256);
  verifyHandoffFacts(stagedRoot, lock);
  compareOrAcceptContracts(stagedRoot, resolve(repoRoot, "contracts"), false);
});
if (args["--out"] === undefined) {
  // Manual ingestion restores the committed authority for subsequent source builds.
  rmSync(buildSelectionPath(repoRoot), { force: true });
}

process.stdout.write(
  `${JSON.stringify({ ...verified, outputRoot }, null, 2)}\n`,
);
