#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "../..");
const defaultRuntimeRoot = resolve(
  repoRoot,
  "src-tauri/resources/integrated-runtimes/dsh",
);
const defaultSourceRoot = resolve(repoRoot, "../MyAgents-dsh");

function exactDirectory(path, name) {
  if (!isAbsolute(path)) {
    throw new Error(`[dsh-dev-freshness] ${name} must be an absolute path`);
  }
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) {
    throw new Error(`[dsh-dev-freshness] ${name} must be a directory`);
  }
  return canonical;
}

function git(sourceRoot, args) {
  return execFileSync("git", ["-C", sourceRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function verifyDshDevelopmentFreshness({
  runtimeRoot = defaultRuntimeRoot,
  sourceRoot = defaultSourceRoot,
  sourceRequired = false,
} = {}) {
  if (!existsSync(sourceRoot)) {
    if (sourceRequired) {
      throw new Error(
        `[dsh-dev-freshness] explicit Runtime source checkout is missing: ${sourceRoot}`,
      );
    }
    return Object.freeze({
      checked: false,
      reason: "sibling-runtime-source-not-present",
    });
  }

  const canonicalRuntimeRoot = exactDirectory(
    resolve(runtimeRoot),
    "Runtime resource root",
  );
  const canonicalSourceRoot = exactDirectory(
    resolve(sourceRoot),
    "Runtime source root",
  );
  const repositoryRoot = realpathSync(
    git(canonicalSourceRoot, ["rev-parse", "--show-toplevel"]),
  );
  if (repositoryRoot !== canonicalSourceRoot) {
    throw new Error(
      "[dsh-dev-freshness] Runtime source root must be the repository root",
    );
  }

  const manifest = JSON.parse(
    readFileSync(
      resolve(
        canonicalRuntimeRoot,
        "runtime-artifact/runtime-artifact-v1.json",
      ),
      "utf8",
    ),
  );
  const bundledHead = manifest?.build?.repositoryHead;
  if (
    typeof bundledHead !== "string" ||
    !/^[0-9a-f]{40}$/u.test(bundledHead)
  ) {
    throw new Error(
      "[dsh-dev-freshness] bundled Runtime lacks an exact source commit",
    );
  }

  const sourceHead = git(canonicalSourceRoot, ["rev-parse", "HEAD"]);
  if (bundledHead !== sourceHead) {
    throw new Error(
      `[dsh-dev-freshness] bundled Runtime is stale: artifact source ${bundledHead}, ` +
        `current MyAgents-dsh source ${sourceHead}. Build and verify a new immutable ` +
        "Runtime handoff, then ingest it before starting Dev.",
    );
  }
  if (git(canonicalSourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
    throw new Error(
      "[dsh-dev-freshness] MyAgents-dsh has uncommitted source changes that cannot be " +
        "present in the bundled immutable Runtime. Commit and rebuild the handoff first.",
    );
  }

  return Object.freeze({
    checked: true,
    repositoryHead: sourceHead,
  });
}

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      (name !== "--runtime-root" && name !== "--source-root") ||
      value === undefined
    ) {
      throw new Error(
        "usage: verify-dsh-dev-freshness [--runtime-root <absolute directory>] " +
          "[--source-root <absolute repository>]",
      );
    }
    parsed[name] = value;
  }
  return parsed;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const explicitSourceRoot = args["--source-root"];
  const sourceRoot =
    explicitSourceRoot ??
    process.env.MYAGENTS_DSH_SOURCE_ROOT ??
    defaultSourceRoot;
  const result = verifyDshDevelopmentFreshness({
    runtimeRoot: args["--runtime-root"] ?? defaultRuntimeRoot,
    sourceRoot,
    sourceRequired:
      explicitSourceRoot !== undefined ||
      process.env.MYAGENTS_DSH_SOURCE_ROOT !== undefined,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(resolve(entrypoint)).href
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
