import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { patchTauriEvents } from './patch-tauri-events.mjs';

const repo = resolve(import.meta.dirname, '..');
const directory = mkdtempSync(resolve(tmpdir(), 'myagents-native-events-'));
const fixture = resolve(import.meta.dirname, 'fixtures/tauri-events');
patchTauriEvents(resolve(repo, 'node_modules/@tauri-apps/api'), true);
mkdirSync(resolve(directory, 'src'));
copyFileSync(resolve(fixture, 'main.rs'), resolve(directory, 'src/main.rs'));
copyFileSync(resolve(repo, 'rust-toolchain.toml'), resolve(directory, 'rust-toolchain.toml'));
copyFileSync(resolve(repo, 'src-tauri/Cargo.lock'), resolve(directory, 'Cargo.lock'));
const tauriPath = resolve(repo, 'vendor/tauri').replaceAll('\\', '/');
writeFileSync(resolve(directory, 'Cargo.toml'), `[package]
name = "myagents-event-lifetime-smoke"
version = "0.0.0"
edition = "2021"
[dependencies]
tauri = { path = ${JSON.stringify(tauriPath)}, features = ["test", "devtools", "macos-private-api", "unstable"] }
serde_json = "1"
[patch.crates-io]
tauri = { path = ${JSON.stringify(tauriPath)} }
tao = { path = ${JSON.stringify(resolve(repo, 'vendor/tao'))} }
tauri-runtime-wry = { path = ${JSON.stringify(resolve(repo, 'vendor/tauri-runtime-wry'))} }
[profile.dev]
debug = "line-tables-only"
`);
const bundle = resolve(directory, 'probe.js');
await build({ entryPoints: [resolve(fixture, 'probe.mjs')], outfile: bundle, bundle: true, format: 'iife', target: 'safari17' });
const target = resolve(repo, 'src-tauri/target');
console.log(`Native event regression artifacts: ${directory}`);
const compiled = spawnSync('cargo', ['build', '--offline', '--manifest-path', resolve(directory, 'Cargo.toml'), '--target-dir', target], { cwd: repo, stdio: 'inherit' });
if (compiled.error) throw compiled.error;
if (compiled.status !== 0) process.exit(compiled.status ?? 1);
const result = resolve(directory, 'result.json');
const binary = resolve(target, 'debug', `myagents-event-lifetime-smoke${process.platform === 'win32' ? '.exe' : ''}`);
const run = spawnSync(binary, [bundle, result], { cwd: directory, stdio: 'inherit', timeout: 300000 });
if (run.error) throw run.error;
if (run.status !== 0) process.exit(run.status ?? 1);
const evidence = JSON.parse(readFileSync(result, 'utf8'));
if (!evidence.success) throw new Error(`Native lifetime regression failed; see ${result}`);
console.log(`PASS: ${result}`);
