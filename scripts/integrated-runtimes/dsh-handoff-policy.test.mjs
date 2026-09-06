import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  compareOrAcceptContracts,
  parseNamedArgs,
  resolveExplicitDirectory,
  stageCompleteHandoff,
  verifyHandoffFacts,
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

    compareOrAcceptContracts(handoffRoot, contractsRoot, true);
    compareOrAcceptContracts(handoffRoot, contractsRoot, false);

    writeFileSync(
      resolve(contractsRoot, "myagents-dsh/protocol-meta.json"),
      "tampered\n",
    );
    assert.throws(
      () => compareOrAcceptContracts(handoffRoot, contractsRoot, false),
      /generated contract contracts\/protocol-meta\.json mismatch/,
    );
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

test("repository lock, generated contracts, resources, and toolchain authorities agree", () => {
  const lock = JSON.parse(
    readFileSync(
      resolve(repoRoot, "src/shared/integrated-runtimes/dsh-lock.json"),
      "utf8",
    ),
  );
  const packageJson = JSON.parse(
    readFileSync(resolve(repoRoot, "package.json"), "utf8"),
  );
  verifyHandoffFacts(resolve(repoRoot, "src-tauri/resources/integrated-runtimes/dsh"), lock);
  const tauriConfig = JSON.parse(
    readFileSync(resolve(repoRoot, "src-tauri/tauri.conf.json"), "utf8"),
  );
  const resourceScripts = [
    "scripts/download_nodejs.sh",
    "setup_windows.ps1",
    "build_windows.ps1",
  ].map((path) => readFileSync(resolve(repoRoot, path), "utf8"));

  assert.equal(lock.runtime.requiredNodeVersion, "24.14.0");
  assert.equal(lock.bundledNpm.version, "11.15.0");
  assert.equal(lock.bundledNpm.authority, "myagents-product-resource");
  assert.equal(lock.protocol.version, "3.1.0");
  assert.equal(lock.protocol.hostMethodCount, 44);
  assert.equal(lock.protocol.reverseMethodCount, 7);
  assert.equal(lock.protocol.notificationCount, 4);
  assert.equal(
    tauriConfig.bundle.resources["../src-tauri/resources/integrated-runtimes"],
    "integrated-runtimes",
  );
  assert.match(packageJson.scripts["tauri:build"], /verify:dsh-runtime/);
  assert.match(packageJson.scripts["tauri:dev"], /verify:dsh-runtime/);
  assert.equal(tauriConfig.build.beforeBundleCommand, undefined);

  for (const script of resourceScripts) {
    assert.match(script, /24\.14\.0/);
    assert.match(script, /11\.15\.0/);
    assert.doesNotMatch(script, /registry\.npmjs\.org\/npm\/latest/);
  }

  const generatedClient = readFileSync(
    resolve(repoRoot, "contracts/myagents-dsh/host-client.generated.ts"),
  );
  const compatibility = readFileSync(
    resolve(
      repoRoot,
      "contracts/myagents-dsh/myagents-dsh-compatibility-v1.json",
    ),
  );
  const schema = readFileSync(
    resolve(repoRoot, "contracts/myagents-dsh/protocol.schema.json"),
  );
  const runtimeManifest = JSON.parse(
    readFileSync(
      resolve(
        repoRoot,
        "src-tauri/resources/integrated-runtimes/dsh/runtime-artifact/runtime-artifact-v1.json",
      ),
      "utf8",
    ),
  );
  assert.equal(
    sha256ForTest(generatedClient),
    lock.handoff.generatedClientSha256,
  );
  assert.equal(sha256ForTest(compatibility), lock.handoff.compatibilitySha256);
  assert.equal(sha256ForTest(schema), lock.protocol.schemaSha256);
  assert.equal(
    runtimeManifest.files.some((entry) => entry.kind === "symlink"),
    false,
  );
});
