import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  CONTRACT_PATHS,
  HANDOFF_MANIFEST,
  RUNTIME_MANIFEST,
  COMPATIBILITY_MANIFEST,
  compareOrAcceptContracts,
  parseNamedArgs,
  resolveExplicitDirectory,
  runPublicVerifier,
  stageCompleteHandoff,
} from "./dsh-handoff-policy.mjs";
import { verifyDshDevelopmentFreshness } from "./verify-dsh-dev-freshness.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");

function sha256ForTest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function withTemporaryDirectory(run) {
  const root = mkdtempSync(resolve(tmpdir(), "myagents-dsh-handoff-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeFixtureFile(path, contents) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

function copyFixtureNode(root, platform = process.platform === "win32" ? "win" : process.platform) {
  const executable = resolve(root, platform === "win" ? "node.exe" : "bin/node");
  mkdirSync(resolve(executable, ".."), { recursive: true });
  copyFileSync(process.execPath, executable);
  return executable;
}

test("public verifier runs with the explicitly selected Node, not the build process Node", () => {
  withTemporaryDirectory((root) => {
    const nodeExecutable = copyFixtureNode(resolve(root, "bundled node"));
    const handoffRoot = resolve(root, "handoff with spaces");
    writeFixtureFile(resolve(handoffRoot, "verify.mjs"), `
      import assert from "node:assert/strict";
      import { realpathSync } from "node:fs";
      assert.equal(realpathSync(process.execPath), ${JSON.stringify(realpathSync(nodeExecutable))});
      assert.equal(realpathSync(process.cwd()), realpathSync(import.meta.dirname));
      assert.equal(process.argv[2], "expected-digest");
      process.stdout.write("verified");
    `);
    assert.equal(runPublicVerifier(handoffRoot, "expected-digest", nodeExecutable), "verified");
    assert.throws(() => runPublicVerifier(handoffRoot, "expected-digest"), /explicit absolute Node executable/);
    assert.throws(() => runPublicVerifier(handoffRoot, "expected-digest", "node"), /explicit absolute Node executable/);
    assert.throws(() => runPublicVerifier(handoffRoot, "wrong-digest", nodeExecutable), /public verifier rejected/);
  });
});

// Exercise the real admission CLIs in an isolated repository. The copied Node
// is a distinct executable; the tiny public verifier rejects the build Node.
// Only fixture manifests are rebound to the locally available test Node, so
// these tests need neither a downloaded runtime nor a second installed version.
function admissionFixture(root, { platform, explicitNodeRoot = false } = {}) {
  root = realpathSync(root);
  const runtimeRoot = resolve(root, "src-tauri/resources/integrated-runtimes/dsh");
  const nodeRoot = resolve(root, explicitNodeRoot ? "custom node distribution" : "src-tauri/resources/nodejs");
  const outputRoot = resolve(root, "accepted dsh");
  const trace = resolve(root, "verifier-calls.jsonl");
  platform ??= process.platform === "win32" ? "win" : process.platform;
  const nodeExecutable = copyFixtureNode(nodeRoot, platform);
  const npmRoot = resolve(nodeRoot, platform === "win" ? "node_modules/npm" : "lib/node_modules/npm");
  const npmVersion = "11.19.0";
  writeFixtureFile(resolve(nodeRoot, ".myagents-nodejs-version"), process.versions.node);
  writeFixtureFile(resolve(nodeRoot, ".myagents-nodejs-platform"), platform);
  writeFixtureFile(resolve(npmRoot, "package.json"), JSON.stringify({ version: npmVersion }));
  writeFixtureFile(resolve(npmRoot, "bin/npm-cli.js"), `process.stdout.write(${JSON.stringify(npmVersion)});`);
  const distributionPath = resolve(root, "scripts/node-runtime.json");
  writeFixtureFile(distributionPath, JSON.stringify({ node: process.versions.node, npm: npmVersion }));
  for (const name of ["dsh-handoff-policy", "dsh-build-selection", "verify-dsh-resources", "ingest-dsh-handoff"]) {
    writeFixtureFile(resolve(root, `scripts/integrated-runtimes/${name}.mjs`),
      readFileSync(resolve(import.meta.dirname, `${name}.mjs`)));
  }

  // The admission tests need consistent manifests and the tracked contracts,
  // not a developer's downloaded Runtime or ignored build selection.
  const lock = JSON.parse(readFileSync(resolve(repoRoot, "src/shared/integrated-runtimes/dsh-lock.json")));
  for (const path of CONTRACT_PATHS) {
    writeFixtureFile(resolve(runtimeRoot, path),
      readFileSync(resolve(repoRoot, "contracts/myagents-dsh", path.slice("contracts/".length))));
  }
  const writeManifest = (path, value) => {
    const contents = JSON.stringify(value);
    writeFixtureFile(resolve(runtimeRoot, path), contents);
    return sha256ForTest(contents);
  };
  const clientPath = "contracts/host-client.generated.ts";
  const noticesPath = "notices/fixture.json";
  writeFixtureFile(resolve(runtimeRoot, noticesPath), '{"fixture":true}');
  lock.handoff.generatedClientSha256 = sha256ForTest(readFileSync(resolve(runtimeRoot, clientPath)));
  lock.handoff.noticesSha256 = sha256ForTest(readFileSync(resolve(runtimeRoot, noticesPath)));
  lock.runtime.requiredNodeVersion = process.versions.node;
  const outer = {
    schemaVersion: 1,
    kind: "myagents-dsh-batch-3-integration-handoff",
    runtime: {}, compatibility: {},
    generatedClient: { path: clientPath, sha256: lock.handoff.generatedClientSha256 },
    notices: { path: noticesPath, sha256: lock.handoff.noticesSha256 },
    platforms: lock.platforms,
  };
  const runtime = {
    build: { repositoryHead: lock.handoff.sourceCommit, toolchain: { node: process.versions.node } },
    runtimeVersion: lock.runtime.version,
    entrypoint: lock.runtime.entrypoint,
    protocol: { version: lock.protocol.version, schemaSha256: lock.protocol.schemaSha256 },
    profile: lock.profile,
    dsh: {
      artifactVersion: lock.dsh.version, sourceCommit: lock.dsh.sourceCommit,
      artifactManifestSha256: lock.dsh.artifactManifestSha256, patchSeriesSha256: lock.dsh.patchSeriesSha256,
    },
  };
  lock.handoff.runtimeManifestSha256 = outer.runtime.manifestSha256 = writeManifest(RUNTIME_MANIFEST, runtime);
  const compatibility = JSON.parse(readFileSync(resolve(runtimeRoot, COMPATIBILITY_MANIFEST)));
  compatibility.runtime.sessionFormat = lock.runtime.sessionFormat;
  compatibility.runtime.artifactSha256 = lock.handoff.runtimeManifestSha256;
  compatibility.protocol.generatedClientSha256 = lock.handoff.generatedClientSha256;
  compatibility.platforms = lock.platforms;
  lock.handoff.compatibilitySha256 = outer.compatibility.sha256 = writeManifest(COMPATIBILITY_MANIFEST, compatibility);
  lock.handoff.manifestSha256 = writeManifest(HANDOFF_MANIFEST, outer);
  const lockPath = resolve(root, "src/shared/integrated-runtimes/dsh-lock.json");
  writeFixtureFile(lockPath, JSON.stringify(lock));
  compareOrAcceptContracts(runtimeRoot, resolve(root, "contracts"), true);
  writeFixtureFile(resolve(runtimeRoot, "verify.mjs"), `
    import assert from "node:assert/strict";
    import { appendFileSync, realpathSync } from "node:fs";
    assert.equal(realpathSync(process.execPath), ${JSON.stringify(realpathSync(nodeExecutable))});
    assert.equal(process.argv[2], ${JSON.stringify(lock.handoff.manifestSha256)});
    appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ cwd: realpathSync(process.cwd()), node: process.execPath }) + "\\n");
    process.stdout.write("verified");
  `);

  return { root, runtimeRoot, nodeRoot, nodeExecutable, npmRoot, outputRoot, trace, lock, lockPath, distributionPath, explicitNodeRoot };
}

function runAdmission(fixture, command, extraArgs = []) {
  const args = command === "ingest-dsh-handoff"
    ? ["--handoff", fixture.runtimeRoot, "--out", fixture.outputRoot]
    : [];
  if (fixture.explicitNodeRoot) args.push("--node-root", fixture.nodeRoot);
  return spawnSync(process.execPath, [
    resolve(fixture.root, `scripts/integrated-runtimes/${command}.mjs`), ...args, ...extraArgs,
  ], { cwd: fixture.root, encoding: "utf8" });
}

for (const command of ["verify-dsh-resources", "ingest-dsh-handoff"]) {
  for (const explicitNodeRoot of [false, true]) {
    test(`${command} uses the ${explicitNodeRoot ? "explicit" : "default"} bundled Node for every public verification`, () => {
      withTemporaryDirectory((root) => {
        const fixture = admissionFixture(root, { explicitNodeRoot });
        const result = runAdmission(fixture, command);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const report = JSON.parse(result.stdout);
        const calls = readFileSync(fixture.trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
        assert.equal(calls[0].cwd, fixture.runtimeRoot);
        if (command === "ingest-dsh-handoff") {
          assert.equal(calls.length, 2, "source and temporary copy must both be verified");
          assert.ok(calls[1].cwd.startsWith(`${fixture.outputRoot}.tmp-`));
          assert.equal(report.outputRoot, fixture.outputRoot);
          compareOrAcceptContracts(fixture.outputRoot, resolve(fixture.root, "contracts"), false);
        } else {
          assert.equal(calls.length, 1);
          assert.equal(report.bundledNodeVersion, process.versions.node);
          assert.equal(report.bundledNpmVersion, "11.19.0");
        }
      });
    });
  }

  for (const [name, mutate, expected] of [
    ["missing Node directory", (f) => rmSync(f.nodeRoot, { recursive: true }), /bundled Node directory is missing.*download_nodejs/],
    ["missing executable", (f) => rmSync(f.nodeExecutable), /bundled toolchain file is missing/],
    ["missing metadata", (f) => rmSync(resolve(f.nodeRoot, ".myagents-nodejs-version")), /bundled toolchain metadata is missing/],
    ["stale Node metadata", (f) => writeFileSync(resolve(f.nodeRoot, ".myagents-nodejs-version"), "0.0.1"), /bundled Node mismatch/],
    ["unsupported platform", (f) => writeFileSync(resolve(f.nodeRoot, ".myagents-nodejs-platform"), "invalid"), /unsupported bundled Node platform/],
    ["distribution drift", (f) => writeFileSync(f.distributionPath, JSON.stringify({ node: "0.0.1", npm: "11.19.0" })), /bundled distribution Node mismatch/],
    ["npm package drift", (f) => writeFileSync(resolve(f.npmRoot, "package.json"), JSON.stringify({ version: "0.0.1" })), /bundled npm mismatch/],
    ["missing npm CLI", (f) => rmSync(resolve(f.npmRoot, "bin/npm-cli.js")), /bundled toolchain file is missing/],
    ["npm executable drift", (f) => writeFileSync(resolve(f.npmRoot, "bin/npm-cli.js"), 'process.stdout.write("0.0.1")'), /bundled npm executable mismatch/],
    ["npm execution failure", (f) => writeFileSync(resolve(f.npmRoot, "bin/npm-cli.js"), 'throw new Error("npm fixture failure")'), /cannot execute bundled Node\/npm.*npm fixture failure/s],
    ["Node executable drift", (f) => {
      f.lock.runtime.requiredNodeVersion = "0.0.1";
      writeFileSync(f.lockPath, JSON.stringify(f.lock));
      writeFileSync(f.distributionPath, JSON.stringify({ node: "0.0.1", npm: "11.19.0" }));
      writeFileSync(resolve(f.nodeRoot, ".myagents-nodejs-version"), "0.0.1");
    }, /bundled Node executable mismatch/],
  ]) {
    test(`${command} rejects ${name} before executing the handoff`, () => {
      withTemporaryDirectory((root) => {
        const fixture = admissionFixture(root);
        mutate(fixture);
        const result = runAdmission(fixture, command);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, expected);
        assert.equal(existsSync(fixture.trace), false);
        assert.equal(existsSync(fixture.outputRoot), false);
      });
    });
  }
}

test("resource verification supports the Windows Node/npm distribution layout", () => {
  withTemporaryDirectory((root) => {
    const fixture = admissionFixture(root, { platform: "win" });
    const result = runAdmission(fixture, "verify-dsh-resources");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).bundledNodeVersion, process.versions.node);
  });
});

test("resource verification cannot skip the Runtime self-check's Node prerequisite", () => {
  withTemporaryDirectory((root) => {
    const fixture = admissionFixture(root);
    const result = runAdmission(fixture, "verify-dsh-resources", ["--skip-node"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown argument: --skip-node/);
    assert.equal(existsSync(fixture.trace), false);
  });
});

test("handoff input requires an explicit absolute canonical directory", () => {
  assert.throws(
    () => resolveExplicitDirectory("relative/handoff", "--handoff"),
    /explicit absolute directory/,
  );
  assert.throws(
    () => resolveExplicitDirectory(resolve(tmpdir(), "missing"), "--handoff"),
    /is not a directory/,
  );
});

test("named arguments reject unknown and valueless options", () => {
  assert.deepEqual(
    parseNamedArgs(["--handoff", "/tmp/example", "--accept"], {
      "--handoff": "value",
      "--accept": "boolean",
    }),
    { "--handoff": "/tmp/example", "--accept": true },
  );
  assert.throws(
    () => parseNamedArgs(["--unknown"], { "--handoff": "value" }),
    /unknown argument/,
  );
  assert.throws(
    () => parseNamedArgs(["--handoff"], { "--handoff": "value" }),
    /missing value/,
  );
});

test("generated contracts are accepted mechanically and then drift-gated", () => {
  withTemporaryDirectory((root) => {
    const handoffRoot = resolve(root, "handoff");
    const contractsRoot = resolve(root, "contracts-root");
    for (const contractPath of CONTRACT_PATHS) {
      const path = resolve(handoffRoot, contractPath);
      mkdirSync(resolve(path, ".."), { recursive: true });
      writeFileSync(path, `${contractPath}\n`);
    }

    const oldEvidence = resolve(contractsRoot, "myagents-dsh/protocol-5.0.0-evidence.json");
    writeFixtureFile(oldEvidence, "previous protocol evidence");
    compareOrAcceptContracts(handoffRoot, contractsRoot, true);
    assert.equal(existsSync(oldEvidence), false);
    assert.equal(existsSync(resolve(contractsRoot, "myagents-dsh/protocol-6.0.0-evidence.json")), true);
    compareOrAcceptContracts(handoffRoot, contractsRoot, false);

    writeFileSync(resolve(handoffRoot, "contracts/myagents-dsh-compatibility-v1.json"), "target-specific identity\n");
    compareOrAcceptContracts(handoffRoot, contractsRoot, false,
      ["contracts/myagents-dsh-compatibility-v1.json"]);
    assert.throws(
      () => compareOrAcceptContracts(handoffRoot, contractsRoot, false),
      /generated contract contracts\/myagents-dsh-compatibility-v1\.json mismatch/,
    );

    writeFileSync(
      resolve(contractsRoot, "myagents-dsh/protocol-meta.json"),
      "tampered\n",
    );
    assert.throws(
      () => compareOrAcceptContracts(handoffRoot, contractsRoot, false,
        ["contracts/myagents-dsh-compatibility-v1.json"]),
      /generated contract contracts\/protocol-meta\.json mismatch/,
    );
  });
});

test("a missing handoff contract cannot partially replace the accepted projection", () => {
  withTemporaryDirectory((root) => {
    const handoffRoot = resolve(root, "handoff");
    const contractsRoot = resolve(root, "contracts-root");
    for (const contractPath of CONTRACT_PATHS.slice(0, -1)) {
      writeFixtureFile(resolve(handoffRoot, contractPath), "new");
    }
    const accepted = resolve(contractsRoot, "myagents-dsh/accepted-patched-dsh-artifact-v1.json");
    const oldEvidence = resolve(contractsRoot, "myagents-dsh/protocol-4.0.0-evidence.json");
    writeFixtureFile(accepted, "accepted");
    writeFixtureFile(oldEvidence, "old evidence");
    assert.throws(() => compareOrAcceptContracts(handoffRoot, contractsRoot, true), /handoff contract is missing/);
    assert.equal(readFileSync(accepted, "utf8"), "accepted");
    assert.equal(readFileSync(oldEvidence, "utf8"), "old evidence");
  });
});

test("complete handoff staging replaces atomically only after verification", () => {
  withTemporaryDirectory((root) => {
    const source = resolve(root, "source");
    const output = resolve(root, "resources/dsh");
    mkdirSync(source, { recursive: true });
    mkdirSync(output, { recursive: true });
    writeFileSync(resolve(source, "marker"), "new");
    writeFileSync(resolve(output, "marker"), "old");

    stageCompleteHandoff(source, output, (staged) => {
      assert.equal(readFileSync(resolve(staged, "marker"), "utf8"), "new");
    });
    assert.equal(readFileSync(resolve(output, "marker"), "utf8"), "new");

    writeFileSync(resolve(source, "marker"), "invalid");
    assert.throws(
      () =>
        stageCompleteHandoff(source, output, () => {
          throw new Error("verification failed");
        }),
      /verification failed/,
    );
    assert.equal(readFileSync(resolve(output, "marker"), "utf8"), "new");
    assert.equal(existsSync(`${output}.backup`), false);

    writeFileSync(resolve(source, "marker"), "next");
    assert.throws(() => stageCompleteHandoff(source, output, () => {}, () => {
      throw new Error("selection publish failed");
    }), /selection publish failed/);
    assert.equal(readFileSync(resolve(output, "marker"), "utf8"), "new");
  });
});

test("sealed handoff evidence can be packaged without changing source bytes or modes", {
  skip: process.platform === "win32",
}, () => {
  withTemporaryDirectory((root) => {
    const source = resolve(root, "handoff");
    const output = resolve(root, "resources/dsh");
    mkdirSync(source);
    writeFileSync(resolve(source, "evidence.json"), '{"verified":true}\n', { mode: 0o400 });
    writeFileSync(resolve(source, "tool"), "#!/bin/sh\nexit 0\n", { mode: 0o500 });
    chmodSync(source, 0o500);
    try {
      if (process.platform === "darwin") {
        const oldBundle = resolve(root, "old.app");
        cpSync(source, oldBundle, { recursive: true });
        try {
          const result = spawnSync("/usr/bin/xattr", ["-crs", oldBundle], { encoding: "utf8" });
          assert.equal(result.status, 1);
          assert.match(result.stderr, /Permission denied/);
        } finally {
          chmodSync(oldBundle, 0o755);
        }
      }
      stageCompleteHandoff(source, output, (staged) => {
        assert.equal(statSync(staged).mode & 0o777, 0o755);
        assert.equal(statSync(resolve(staged, "evidence.json")).mode & 0o777, 0o644);
        assert.equal(statSync(resolve(staged, "tool")).mode & 0o777, 0o755);
        for (const name of ["evidence.json", "tool"]) {
          assert.deepEqual(readFileSync(resolve(staged, name)), readFileSync(resolve(source, name)));
        }
        if (process.platform === "darwin") {
          execFileSync("/usr/bin/xattr", ["-crs", staged]);
        }
      });
      assert.equal(statSync(source).mode & 0o777, 0o500);
      assert.equal(statSync(resolve(source, "evidence.json")).mode & 0o777, 0o400);
      assert.equal(statSync(resolve(source, "tool")).mode & 0o777, 0o500);
    } finally {
      chmodSync(source, 0o755);
    }
  });
});

test("resource permissions never follow a link outside the staging copy", {
  skip: process.platform === "win32",
}, () => {
  withTemporaryDirectory((root) => {
    const source = resolve(root, "handoff");
    const output = resolve(root, "resources/dsh");
    const outside = resolve(root, "outside.json");
    mkdirSync(source);
    mkdirSync(output, { recursive: true });
    writeFileSync(resolve(output, "marker"), "accepted");
    writeFileSync(outside, "sealed", { mode: 0o400 });
    symlinkSync(outside, resolve(source, "link"));
    assert.throws(() => stageCompleteHandoff(source, output, () => {
      assert.fail("a linked copy cannot reach verification");
    }), /link-free/);
    assert.equal(statSync(outside).mode & 0o777, 0o400);
    assert.equal(readFileSync(resolve(output, "marker"), "utf8"), "accepted");
  });
});

test("Dev freshness binds the bundled Runtime to one clean source commit", () => {
  withTemporaryDirectory((root) => {
    const sourceRoot = resolve(root, "MyAgents-dsh");
    const runtimeRoot = resolve(root, "runtime");
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(resolve(runtimeRoot, "runtime-artifact"), { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: sourceRoot });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], {
      cwd: sourceRoot,
    });
    execFileSync("git", ["config", "user.name", "Runtime Test"], {
      cwd: sourceRoot,
    });
    writeFileSync(resolve(sourceRoot, "tracked.txt"), "clean\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: sourceRoot });
    execFileSync("git", ["commit", "--quiet", "-m", "test: fixture"], {
      cwd: sourceRoot,
    });
    const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRoot,
      encoding: "utf8",
    }).trim();
    const manifestPath = resolve(
      runtimeRoot,
      "runtime-artifact/runtime-artifact-v1.json",
    );
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ build: { repositoryHead: sourceHead } })}\n`,
    );

    assert.deepEqual(
      verifyDshDevelopmentFreshness({ runtimeRoot, sourceRoot }),
      { checked: true, repositoryHead: sourceHead },
    );

    writeFileSync(resolve(sourceRoot, "tracked.txt"), "dirty\n");
    assert.throws(
      () => verifyDshDevelopmentFreshness({ runtimeRoot, sourceRoot }),
      /uncommitted source changes/,
    );
    execFileSync("git", ["checkout", "--", "tracked.txt"], { cwd: sourceRoot });

    writeFileSync(
      manifestPath,
      `${JSON.stringify({ build: { repositoryHead: "0".repeat(40) } })}\n`,
    );
    assert.throws(
      () => verifyDshDevelopmentFreshness({ runtimeRoot, sourceRoot }),
      /bundled Runtime is stale/,
    );
  });
});
