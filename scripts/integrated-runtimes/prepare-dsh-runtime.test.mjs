import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { acquireRelease, currentTarget, deriveLocalLock, deriveReleaseLock, hasTargetNativeAddon, parseReleaseManifest, prepareDshRuntime, releaseAssetUrl } from "./prepare-dsh-runtime.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("release URL is determined by an exact tag and target asset", () => {
  assert.equal(currentTarget("darwin", "arm64"), "darwin-arm64");
  assert.equal(currentTarget("darwin", "x64"), "darwin-x64");
  assert.equal(currentTarget("win32", "x64"), "win32-x64");
  assert.equal(releaseAssetUrl("v0.1.0", "myagents-dsh-v0.1.0-darwin-arm64.tar.gz"),
    "https://github.com/hAcKlyc/MyAgents-dsh/releases/download/v0.1.0/myagents-dsh-v0.1.0-darwin-arm64.tar.gz");
  assert.throws(() => releaseAssetUrl("latest", "myagents-dsh-v0.1.0-darwin-arm64.tar.gz"));
  assert.equal(releaseAssetUrl("v0.1.0", "myagents-dsh-v0.1.0-darwin-x64.tar.gz"),
    "https://github.com/hAcKlyc/MyAgents-dsh/releases/download/v0.1.0/myagents-dsh-v0.1.0-darwin-x64.tar.gz");
  assert.equal(releaseAssetUrl("v0.1.0", "manifest.json"),
    "https://github.com/hAcKlyc/MyAgents-dsh/releases/download/v0.1.0/manifest.json");
});

const releaseTargets = ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"];
const manifestFixture = (asset) => ({
  schemaVersion: 1, repository: "hAcKlyc/MyAgents-dsh", version: "0.1.0", tag: "v0.1.0",
  sourceCommit: "a".repeat(40),
  assets: Object.fromEntries(releaseTargets.map((target) => [target, {
    name: `myagents-dsh-v0.1.0-${target}.tar.gz`, sha256: asset.sha256,
    size: asset.size, handoffSha256: asset.handoffSha256,
    runtimeManifestSha256: asset.runtimeManifestSha256,
    compatibilitySha256: asset.compatibilitySha256, claim: "verified",
  }])),
});

test("manifest must describe all four verified targets at the selected version", () => {
  const fixture = manifestFixture({ sha256: "a".repeat(64), size: 1,
    handoffSha256: "b".repeat(64), runtimeManifestSha256: "c".repeat(64),
    compatibilitySha256: "d".repeat(64) });
  assert.deepEqual(parseReleaseManifest(Buffer.from(JSON.stringify(fixture)), "0.1.0"), fixture);
  delete fixture.assets["win32-x64"];
  assert.throws(() => parseReleaseManifest(Buffer.from(JSON.stringify(fixture)), "0.1.0"), /all four targets/);
});

test("native module check uses the correct platform package", () => {
  const files = [
    { path: "node_modules/@deepseek-ai/node-addon-system-darwin-x64/bin/system.node" },
    { path: "node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node" },
  ];
  assert.equal(hasTargetNativeAddon(files, "darwin-x64"), true);
  assert.equal(hasTargetNativeAddon(files, "win32-x64"), true);
  assert.equal(hasTargetNativeAddon(files, "darwin-arm64"), false);
});

test("release cache uses exact archive bytes and reacquires a corrupt cache", async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "myagents-dsh-release-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, "source/handoff"), { recursive: true });
  writeFileSync(resolve(root, "source/handoff/marker"), "release bytes");
  const archive = resolve(root, "fixture.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", resolve(root, "source"), "handoff"]);
  const bytes = readFileSync(archive);
  const manifest = manifestFixture({ sha256: sha(bytes), size: bytes.length,
    handoffSha256: sha("handoff"), runtimeManifestSha256: sha("runtime"),
    compatibilitySha256: sha("compatibility") });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  let downloads = 0;
  const download = async (url, options) => {
    downloads += 1;
    assert.equal(options.redirect, "follow");
    if (url === releaseAssetUrl(manifest.tag, "manifest.json")) return manifestBytes;
    assert.equal(url, releaseAssetUrl(manifest.tag, manifest.assets["darwin-arm64"].name));
    return bytes;
  };
  let found = await acquireRelease(root, "0.1.0", "darwin-arm64", download);
  assert.equal(readFileSync(resolve(found.root, "marker"), "utf8"), "release bytes");
  assert.equal(found.manifestSha256, sha(manifestBytes));
  found.cleanup();
  assert.equal(downloads, 2);
  found = await acquireRelease(root, "0.1.0", "darwin-arm64", download);
  found.cleanup();
  assert.equal(downloads, 2);
  const cache = resolve(root, "src-tauri/resources/dsh-release-cache", `${sha(bytes)}.tar.gz`);
  writeFileSync(cache, "corrupt");
  found = await acquireRelease(root, "0.1.0", "darwin-arm64", download);
  found.cleanup();
  assert.equal(downloads, 3);
  assert.equal(sha(readFileSync(cache)), sha(bytes));
  assert.ok(existsSync(cache));
});

test("release source fails before network without an exact pin", async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "myagents-dsh-unpinned-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, "src/shared/integrated-runtimes"), { recursive: true });
  writeFileSync(resolve(root, "src/shared/integrated-runtimes/dsh-lock.json"), "{}");
  let downloaded = false;
  await assert.rejects(prepareDshRuntime({ repoRoot: root, target: "darwin-arm64", download: async () => { downloaded = true; } }),
    /cannot read JSON .*dsh-release\.json/);
  assert.equal(downloaded, false);
});

test("local identity derives from the handoff without changing the committed lock", (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "myagents-dsh-local-lock-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value) => {
    const dest = resolve(root, path);
    mkdirSync(resolve(dest, ".."), { recursive: true });
    writeFileSync(dest, JSON.stringify(value));
    return sha(readFileSync(dest));
  };
  const runtime = {
    build: { repositoryHead: "source-commit", toolchain: { node: "24.20.0" } },
    runtimeVersion: "1.2.3", entrypoint: "runtime.mjs",
    protocol: { version: "6.0.0", schemaSha256: "schema" },
    profile: { id: "profile", digest: "profile-digest" },
    dsh: { artifactVersion: "dsh-version", sourceCommit: "upstream", artifactManifestSha256: "artifact", patchSeriesSha256: "patch" },
  };
  const compatibility = { runtime: { sessionFormat: "format" } };
  const outer = {
    runtime: { manifestSha256: write("runtime-artifact/runtime-artifact-v1.json", runtime) },
    compatibility: { sha256: write("contracts/myagents-dsh-compatibility-v1.json", compatibility) },
    generatedClient: { sha256: "client" }, notices: { sha256: "notices" }, platforms: [{ target: "darwin-arm64" }],
  };
  write("contracts/protocol-meta.json", { hostMethods: [1, 2], reverseMethods: [1], notifications: [1] });
  const handoffSha = write("batch-3-integration-handoff-v1.json", outer);
  const releaseLock = { bundledNpm: { version: "11.19.0" }, handoff: { manifestSha256: "old" }, release: { tag: "v0.1.0" } };
  const { lock } = deriveLocalLock(releaseLock, root);
  assert.equal(lock.handoff.manifestSha256, handoffSha);
  assert.equal(lock.handoff.sourceCommit, "source-commit");
  assert.equal(lock.protocol.hostMethodCount, 2);
  assert.equal(lock.runtime.sessionFormat, "format");
  assert.equal(lock.release, undefined);
  assert.equal(releaseLock.handoff.manifestSha256, "old");
  const manifest = manifestFixture({ sha256: "a".repeat(64), size: 1,
    handoffSha256: handoffSha, runtimeManifestSha256: outer.runtime.manifestSha256,
    compatibilitySha256: outer.compatibility.sha256 });
  manifest.sourceCommit = "source-commit";
  const release = deriveReleaseLock(releaseLock, root, "darwin-x64", manifest, "f".repeat(64));
  assert.equal(release.lock.handoff.manifestSha256, handoffSha);
  assert.equal(release.lock.release.tag, "v0.1.0");
  manifest.assets["darwin-arm64"].handoffSha256 = "0".repeat(64);
  assert.throws(() => deriveReleaseLock(releaseLock, root, "darwin-arm64", manifest, "f".repeat(64)), /differs from the darwin-arm64 manifest/);
});
