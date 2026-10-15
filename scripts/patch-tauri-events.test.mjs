import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { patchTauriEvents } from './patch-tauri-events.mjs';

const root = resolve(import.meta.dirname, '..');
const installed = resolve(root, 'node_modules/@tauri-apps/api');
const repair = JSON.parse(readFileSync(resolve(import.meta.dirname, 'patches/tauri-events.json'), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(run) {
  const directory = mkdtempSync(resolve(tmpdir(), 'myagents-tauri-patch-'));
  try {
    writeFileSync(resolve(directory, 'package.json'), JSON.stringify({ name: '@tauri-apps/api', version: repair.apiVersion }));
    for (const [name, patch] of Object.entries(repair.files)) {
      const bytes = readFileSync(resolve(installed, name), 'utf8');
      writeFileSync(resolve(directory, name), digest(bytes) === patch.original ? bytes : bytes.replace(patch.to, patch.from));
    }
    return run(directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('installed event dependency has the paired repair', () => patchTauriEvents(installed, true));
test('both distribution formats are patched exactly and reruns are idempotent', () => fixture(directory => {
  assert.throws(() => patchTauriEvents(directory, true), /npm run postinstall/);
  patchTauriEvents(directory); patchTauriEvents(directory); patchTauriEvents(directory, true);
  for (const [name, patch] of Object.entries(repair.files)) assert.equal(digest(readFileSync(resolve(directory, name))), patch.repaired);
}));
test('unexpected distribution bytes abort before either format is written', () => fixture(directory => {
  writeFileSync(resolve(directory, 'event.cjs'), 'unexpected bytes');
  assert.throws(() => patchTauriEvents(directory), /Unexpected Tauri/);
  assert.equal(digest(readFileSync(resolve(directory, 'event.js'))), repair.files['event.js'].original);
}));
test('upgrades require explicit lifetime regression review', () => fixture(directory => {
  writeFileSync(resolve(directory, 'package.json'), JSON.stringify({ name: '@tauri-apps/api', version: '2.12.0' }));
  assert.throws(() => patchTauriEvents(directory), /before upgrading/);
}));
test('vendored Rust change is restricted to its documented event generator', () => {
  const directory = resolve(root, 'vendor/tauri');
  const upstream = JSON.parse(readFileSync(resolve(directory, 'UPSTREAM_FILES.json'), 'utf8'));
  for (const [file, sha] of Object.entries(upstream)) {
    assert.equal(digest(readFileSync(resolve(directory, file))), file === repair.nativeFile ? repair.nativeSha256 : sha, file);
  }
});
test('app builds select the paired dependency and verify the npm patch', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies['@tauri-apps/api'], repair.apiVersion);
  for (const name of ['predev:web', 'prebuild:web', 'pretypecheck']) assert.ok(pkg.scripts[name].includes('patch-tauri-events.mjs --check'), name);
  assert.ok(pkg.scripts.postinstall.includes('patch-tauri-events.mjs'));
  const cargo = readFileSync(resolve(root, 'src-tauri/Cargo.toml'), 'utf8');
  assert.match(cargo, /\[patch\.crates-io\]\s+tauri = \{ path = "\.\.\/vendor\/tauri" \}/);
  assert.equal((cargo.match(/tauri = \{ version = "=2\.11\.2"/g) ?? []).length, 2);
});
