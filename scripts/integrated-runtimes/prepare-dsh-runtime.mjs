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
const releaseTargets = ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"];
const shaPattern = /^[a-f0-9]{64}$/;
const sourcePattern = /^[a-f0-9]{40}$/;
const versionPattern = /^\d+\.\d+\.\d+$/;

export function currentTarget(platform = process.platform, arch = process.arch) {
  const os = platform === "win32" ? "win32" : platform;
  const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : arch;
  return `${os}-${cpu}`;
}

export function releaseAssetUrl(tag, asset) {
  if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)
    || (asset !== "manifest.json"
      && !/^myagents-dsh-v[0-9A-Za-z.+-]+-(?:darwin-arm64|darwin-x64|linux-x64|win32-x64)\.tar\.gz$/.test(asset))) {
    throw new Error("DSH release tag or asset name is invalid");
  }
  return `https://github.com/${releaseRepository}/releases/download/${tag}/${asset}`;
}

export function parseReleaseManifest(bytes, version) {
  if (!versionPattern.test(version)) throw new Error("MyAgents-dsh version must be stable X.Y.Z");
  if (bytes.length > 64 * 1024) throw new Error("MyAgents-dsh Release manifest is too large");
  const manifest = JSON.parse(bytes.toString("utf8"));
  const tag = `v${version}`;
  if (manifest.schemaVersion !== 1 || manifest.repository !== releaseRepository
    || manifest.version !== version || manifest.tag !== tag
    || !sourcePattern.test(manifest.sourceCommit ?? "")
    || !manifest.assets || typeof manifest.assets !== "object" || Array.isArray(manifest.assets)
    || JSON.stringify(Object.keys(manifest.assets).sort()) !== JSON.stringify([...releaseTargets].sort())) {
    throw new Error(`MyAgents-dsh Release manifest does not describe ${tag} and all four targets`);
  }
  for (const target of releaseTargets) {
    const asset = manifest.assets[target];
    if (asset?.name !== `myagents-dsh-${tag}-${target}.tar.gz`
      || !shaPattern.test(asset.sha256 ?? "") || !shaPattern.test(asset.handoffSha256 ?? "")
      || !shaPattern.test(asset.runtimeManifestSha256 ?? "")
      || !shaPattern.test(asset.compatibilitySha256 ?? "")
      || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.claim !== "verified") {
      throw new Error(`MyAgents-dsh Release manifest has no verified ${target} archive`);
    }
  }
  return manifest;
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

export function deriveReleaseLock(releaseLock, handoffRoot, target, manifest, manifestSha256) {
  const selected = deriveLocalLock(releaseLock, handoffRoot);
  const asset = manifest.assets[target];
  if (!asset || selected.lock.handoff.manifestSha256 !== asset.handoffSha256
    || selected.lock.handoff.sourceCommit !== manifest.sourceCommit
    || selected.lock.handoff.runtimeManifestSha256 !== asset.runtimeManifestSha256
    || selected.lock.handoff.compatibilitySha256 !== asset.compatibilitySha256) {
    throw new Error(`MyAgents-dsh Release handoff identity differs from the ${target} manifest`);
  }
  selected.lock.release = { version: manifest.version, tag: manifest.tag,
    sourceCommit: manifest.sourceCommit, manifestSha256, archiveSha256: asset.sha256 };
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

export async function acquireRelease(repoRoot, version, target, download) {
  if (!versionPattern.test(version)) throw new Error("No stable MyAgents-dsh version in dsh-release.json");
  if (!releaseTargets.includes(target)) throw new Error(`Unsupported MyAgents-dsh Release target: ${target}`);
  const tag = `v${version}`;
  const cacheRoot = resolve(repoRoot, "src-tauri/resources/dsh-release-cache");
  mkdirSync(cacheRoot, { recursive: true });
  const manifestCache = resolve(cacheRoot, `${tag}-manifest.json`);
  let manifestBytes;
  let manifest;
  if (existsSync(manifestCache)) {
    try {
      manifestBytes = readFileSync(manifestCache);
      manifest = parseReleaseManifest(manifestBytes, version);
    } catch {
      manifestBytes = undefined;
    }
  }
  if (!manifestBytes) {
    const manifestUrl = releaseAssetUrl(tag, "manifest.json");
    manifestBytes = await download(manifestUrl, { maxBytes: 64 * 1024, redirect: "follow" });
    manifest = parseReleaseManifest(manifestBytes, version);
    const temporary = `${manifestCache}.tmp-${randomUUID()}`;
    try {
      writeFileSync(temporary, manifestBytes);
      renameSync(temporary, manifestCache);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  const pin = manifest.assets[target];
  const url = releaseAssetUrl(tag, pin.name);
  const archive = resolve(cacheRoot, `${pin.sha256}.tar.gz`);
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
    execFileSync("tar", ["-xzf", "-"], { cwd: extractionRoot, input: bytes, stdio: "pipe" });
    const handoff = resolve(extractionRoot, "handoff");
    if (!existsSync(handoff) || !statSync(handoff).isDirectory()) {
      throw new Error(`DSH Release asset has no handoff/ directory: ${url}`);
    }
    return { root: handoff, cleanup: () => rmSync(extractionRoot, { recursive: true, force: true }),
      url, manifest, manifestSha256: digest(manifestBytes) };
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
    const version = readJson(resolve(repoRoot, "src/shared/integrated-runtimes/dsh-release.json")).version;
    input = await acquireRelease(repoRoot, version, target, download);
  }
  try {
    const { lock, compatibility } = source === "release"
      ? deriveReleaseLock(releaseLock, input.root, target, input.manifest, input.manifestSha256)
      : deriveLocalLock(releaseLock, input.root);
    assertTarget(lock, target, source);
    assertNativeRuntimeTarget(input.root, target);
    const { nodeExecutable } = verifyBundledToolchain(repoRoot, lock, nodeRoot);
    verifySelectedHandoff(input.root, lock, repoRoot, nodeExecutable);
    const outputRoot = resolve(repoRoot, "src-tauri/resources/integrated-runtimes/dsh");
    const selectionPath = buildSelectionPath(repoRoot);
    const temporary = `${selectionPath}.tmp-${randomUUID()}`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, source, target, lock, compatibility }, null, 2)}\n`);
      stageCompleteHandoff(input.root, outputRoot, (staged) =>
        verifySelectedHandoff(staged, lock, repoRoot, nodeExecutable),
      () => renameSync(temporary, selectionPath));
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
