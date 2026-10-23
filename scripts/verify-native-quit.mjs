import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

if (process.platform !== 'darwin') throw new Error('Native AppKit quit regression requires macOS.');
const repo = resolve(import.meta.dirname, '..');
const directory = mkdtempSync(resolve(tmpdir(), 'myagents-native-quit-'));
mkdirSync(resolve(directory, 'src'));
copyFileSync(resolve(repo, 'scripts/fixtures/native-quit/main.rs'), resolve(directory, 'src/main.rs'));
copyFileSync(resolve(repo, 'rust-toolchain.toml'), resolve(directory, 'rust-toolchain.toml'));
copyFileSync(resolve(repo, 'src-tauri/Cargo.lock'), resolve(directory, 'Cargo.lock'));
const localPatches = ['tauri', 'tao', 'tauri-runtime-wry']
  .map(name => `${name} = { path = ${JSON.stringify(resolve(repo, 'vendor', name))} }`).join('\n');
writeFileSync(resolve(directory, 'Cargo.toml'), `[package]
name = "myagents-native-quit-smoke"
version = "0.0.0"
edition = "2021"
[dependencies]
tauri = { version = "=2.11.2", features = ["test", "devtools", "macos-private-api", "unstable"] }
serde_json = "1"
dispatch2 = "0.3.1"
objc2 = "0.6"
objc2-app-kit = { version = "0.3.2", features = ["NSApplication"] }
[patch.crates-io]
${localPatches}
[profile.dev]
debug = "line-tables-only"
`);
const target = resolve(repo, 'src-tauri/target');
console.log(`Native quit regression artifacts: ${directory}`);
const compiled = spawnSync('cargo', ['build', '--offline', '--manifest-path', resolve(directory, 'Cargo.toml'), '--target-dir', target], { cwd: repo, stdio: 'inherit' });
if (compiled.error) throw compiled.error;
if (compiled.status !== 0) process.exit(compiled.status ?? 1);
let failed = false;
for (const mode of ['native', 'cancel-confirm', 'native-reentrant', 'last-window', 'explicit', 'restart']) {
  const result = resolve(directory, `${mode}.json`);
  const run = spawnSync(resolve(target, 'debug/myagents-native-quit-smoke'), [mode, result], { cwd: directory, stdio: 'inherit', timeout: 30000 });
  if (run.error) throw run.error;
  const evidence = JSON.parse(readFileSync(result, 'utf8'));
  console.log(JSON.stringify(evidence));
  if (run.status !== 0 || !evidence.success) failed = true;
}
process.exitCode = failed ? 1 : 0;
