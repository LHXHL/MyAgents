import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
} from "./dsh-handoff-policy.mjs";

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
  assert.equal(lock.protocol.version, "2.1.0");
  assert.equal(lock.protocol.hostMethodCount, 40);
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
