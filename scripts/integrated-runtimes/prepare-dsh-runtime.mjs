#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { downloadBuildResource } from "../build-resource-download.mjs";
import {
  COMPATIBILITY_MANIFEST, HANDOFF_MANIFEST, PROTOCOL_META, RUNTIME_MANIFEST,
  compareOrAcceptContracts, parseNamedArgs, readJson, resolveExplicitDirectory,
  runPublicVerifier, sha256File, stageCompleteHandoff, verifyBundledToolchain,
  verifyHandoffFacts,
} from "./dsh-handoff-policy.mjs";
import { buildSelectionPath } from "./dsh-build-selection.mjs";

const defaultRoot = resolve(import.meta.dirname, "../..");
const releaseRepository = "hAcKlyc/MyAgents-dsh";
const compatibilityContract = "contracts/myagents-dsh-compatibility-v1.json";

export function currentTarget(platform = process.platform, arch = process.arch) {
  const os = platform === "win32" ? "win32" : platform;
  const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : arch;
  return `${os}-${cpu}`;
}

export function releaseAssetUrl(tag, asset) {
  if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)
    || !/^myagents-dsh-v[0-9A-Za-z.+-]+-(?:darwin-arm64|darwin-x64|linux-x64|win32-x64)\.tar\.gz$/.test(asset)) {
    throw new Error("DSH release tag or asset name is invalid");
  }
  return `https://github.com/${releaseRepository}/releases/download/${tag}/${asset}`;
}

export function deriveLocalLock(releaseLock, handoffRoot) {
  const outer = readJson(resolve(handoffRoot, HANDOFF_MANIFEST));
  const runtime = readJson(resolve(handoffRoot, RUNTIME_MANIFEST));
  const compatibility = readJson(resolve(handoffRoot, COMPATIBILITY_MANIFEST));
  const meta = readJson(resolve(handoffRoot, PROTOCOL_META));
  const lock = structuredClone(releaseLock);
  delete lock.release;
  lock.handoff = {
    manifestSha256: sha256File(resolve(handoffRoot, HANDOFF_MANIFEST)),
    sourceCommit: runtime.build.repositoryHead,
    runtimeManifestSha256: outer.runtime.manifestSha256,
    compatibilitySha256: outer.compatibility.sha256,
    generatedClientSha256: outer.generatedClient.sha256,
    noticesSha256: outer.notices.sha256,
  };
  lock.runtime = {
    version: runtime.runtimeVersion,
    entrypoint: runtime.entrypoint,
    sessionFormat: compatibility.runtime.sessionFormat,
    requiredNodeVersion: runtime.build.toolchain.node,
  };
  lock.protocol = {
    version: runtime.protocol.version,
    schemaSha256: runtime.protocol.schemaSha256,
    hostMethodCount: meta.hostMethods.length,
    reverseMethodCount: meta.reverseMethods.length,
    notificationCount: meta.notifications.length,
  };
  lock.profile = { id: runtime.profile.id, digest: runtime.profile.digest };
  lock.dsh = {
    version: runtime.dsh.artifactVersion,
    sourceCommit: runtime.dsh.sourceCommit,
    artifactManifestSha256: runtime.dsh.artifactManifestSha256,
    patchSeriesSha256: runtime.dsh.patchSeriesSha256,
  };
  lock.platforms = outer.platforms;
  return { lock, compatibility };
}

export function deriveReleaseLock(releaseLock, handoffRoot, target) {
  const selected = deriveLocalLock(releaseLock, handoffRoot);
  const pin = releaseLock.release?.assets?.[target];
  if (!pin || selected.lock.handoff.manifestSha256 !== pin.handoffSha256
    || selected.lock.handoff.sourceCommit !== releaseLock.release.sourceCommit) {
    throw new Error(`MyAgents-dsh Release handoff identity differs from the ${target} pin`);
  }
  selected.lock.release = releaseLock.release;
  return selected;
}

function assertTarget(lock, target, source) {
  const claim = lock.platforms.find((platform) => platform.target === target);
  if (!claim) {
    throw new Error(`DSH handoff has no ${target} platform claim`);
  }
  if (source === "release" && claim.claim !== "verified") {
    throw new Error(`DSH Release has no verified ${target} platform claim`);
  }
}

export function hasTargetNativeAddon(files, target) {
  const packageName = target === "win32-x64"
    ? "@napi-rs/canvas-win32-x64-msvc"
    : `@deepseek-ai/node-addon-system-${target}`;
  const prefix = `node_modules/${packageName}/`;
  return files.some((file) => file.path.startsWith(prefix) && file.path.endsWith(".node"));
}

function assertNativeRuntimeTarget(root, target) {
  const runtime = readJson(resolve(root, RUNTIME_MANIFEST));
  if (!hasTargetNativeAddon(runtime.files, target)) {
    throw new Error(`DSH Runtime has no ${target} native addon; rebuild that target's handoff`);
  }
}

function verifySelectedHandoff(root, lock, repoRoot, nodeExecutable) {
  runPublicVerifier(root, lock.handoff.manifestSha256, nodeExecutable);
  verifyHandoffFacts(root, lock);
  compareOrAcceptContracts(root, resolve(repoRoot, "contracts"), false, [compatibilityContract]);
}

function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function acquireRelease(repoRoot, lock, target, download) {
  const pin = lock.release?.assets?.[target];
  if (!lock.release?.tag || !lock.release?.sourceCommit || !pin?.name
    || !/^[a-f0-9]{64}$/.test(pin.sha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(pin.handoffSha256 ?? "")
    || !Number.isSafeInteger(pin.size) || pin.size <= 0) {
    throw new Error(`No pinned MyAgents-dsh Release asset for ${target} in dsh-lock.json`);
  }
  if (pin.name !== `myagents-dsh-${lock.release.tag}-${target}.tar.gz`) {
    throw new Error(`MyAgents-dsh Release asset name differs from pinned tag and target: ${pin.name}`);
  }
  const url = releaseAssetUrl(lock.release.tag, pin.name);
  const cacheRoot = resolve(repoRoot, "src-tauri/resources/dsh-release-cache");
  const archive = resolve(cacheRoot, `${pin.sha256}.tar.gz`);
  mkdirSync(cacheRoot, { recursive: true });
  let bytes;
  if (existsSync(archive)) {
    bytes = readFileSync(archive);
    if (bytes.length !== pin.size || digest(bytes) !== pin.sha256) bytes = undefined;
  }
  if (!bytes) {
    bytes = await download(url, { maxBytes: pin.size, redirect: "follow" });
    if (bytes.length !== pin.size || digest(bytes) !== pin.sha256) {
      throw new Error(`DSH Release asset integrity mismatch: ${url}`);
    }
    const temporary = `${archive}.tmp-${randomUUID()}`;
    try {
      writeFileSync(temporary, bytes);
      renameSync(temporary, archive);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  const extractionRoot = mkdtempSync(resolve(tmpdir(), "myagents-dsh-release-"));
  try {
    // The archive is accepted only by the exact committed SHA before extraction.
    execFileSync("tar", ["-xzf", archive, "-C", extractionRoot], { stdio: "pipe" });
    const handoff = resolve(extractionRoot, "handoff");
    if (!existsSync(handoff) || !statSync(handoff).isDirectory()) {
      throw new Error(`DSH Release asset has no handoff/ directory: ${url}`);
    }
    return { root: handoff, cleanup: () => rmSync(extractionRoot, { recursive: true, force: true }), url };
  } catch (error) {
    rmSync(extractionRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function prepareDshRuntime({
  repoRoot = defaultRoot, source = "release", handoff, target = currentTarget(),
  nodeRoot, download = downloadBuildResource,
} = {}) {
  if (source !== "release" && source !== "local") throw new Error(`Unknown DSH source: ${source}`);
  if (source === "local" && !handoff) throw new Error("Local DSH source requires --handoff /absolute/path");
  if (source === "release" && handoff) throw new Error("--handoff requires --source local");
  const releaseLock = readJson(resolve(repoRoot, "src/shared/integrated-runtimes/dsh-lock.json"));
  let input;
  if (source === "local") {
    input = { root: resolveExplicitDirectory(handoff, "--handoff"), cleanup: () => {} };
  } else {
    input = await acquireRelease(repoRoot, releaseLock, target, download);
  }
  try {
    const { lock, compatibility } = source === "release"
      ? deriveReleaseLock(releaseLock, input.root, target)
      : deriveLocalLock(releaseLock, input.root);
    assertTarget(lock, target, source);
    assertNativeRuntimeTarget(input.root, target);
    const { nodeExecutable } = verifyBundledToolchain(repoRoot, lock, nodeRoot);
    verifySelectedHandoff(input.root, lock, repoRoot, nodeExecutable);
    const outputRoot = resolve(repoRoot, "src-tauri/resources/integrated-runtimes/dsh");
    stageCompleteHandoff(input.root, outputRoot, (staged) =>
      verifySelectedHandoff(staged, lock, repoRoot, nodeExecutable));
    const selectionPath = buildSelectionPath(repoRoot);
    const temporary = `${selectionPath}.tmp-${randomUUID()}`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, source, target, lock, compatibility }, null, 2)}\n`);
      renameSync(temporary, selectionPath);
    } finally {
      rmSync(temporary, { force: true });
    }
    return { source, target, sourceCommit: lock.handoff.sourceCommit,
      handoffSha256: lock.handoff.manifestSha256,
      runtimeSha256: lock.handoff.runtimeManifestSha256,
      archiveUrl: input.url, outputRoot };
  } finally {
    input.cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = parseNamedArgs(process.argv.slice(2), {
      "--source": "value", "--handoff": "value", "--target": "value", "--node-root": "value",
    });
    const result = await prepareDshRuntime({
      source: args["--source"], handoff: args["--handoff"],
      target: args["--target"], nodeRoot: args["--node-root"],
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
