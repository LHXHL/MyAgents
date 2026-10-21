import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repo = resolve(import.meta.dirname, '..');
const build = readFileSync(join(repo, 'build_macos.sh'), 'utf8');
const unix = { skip: process.platform === 'win32' };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'myagents notary '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const shimDir = join(root, 'scripts/macos-notary-tools');
  mkdirSync(shimDir, { recursive: true });
  const recorder = join(root, 'record.cjs');
  writeFileSync(recorder, `process.stdout.write(JSON.stringify(process.argv.slice(2))); process.stderr.write('tool stderr'); process.exit(Number(process.env.TOOL_EXIT || 0));`);
  const realTool = join(root, 'system-xcrun');
  writeFileSync(realTool, `#!/bin/bash\nexec "${process.execPath}" "${recorder}" "$@"\n`);
  chmodSync(realTool, 0o755);
  // Substitute only the OS executable boundary; execute the production dispatcher.
  const shim = readFileSync(join(repo, 'scripts/macos-notary-tools/xcrun'), 'utf8');
  assert.match(shim, /\/usr\/bin\/xcrun/);
  writeFileSync(join(shimDir, 'xcrun'), shim.replaceAll('/usr/bin/xcrun', realTool));
  chmodSync(join(shimDir, 'xcrun'), 0o755);
  return { root, shimDir };
}

test('notarization disables acceleration without changing credentials, JSON output or wait', unix, t => {
  const { shimDir } = fixture(t);
  const args = ['notarytool', 'submit', '/a path/MyAgents.zip', '--output-format', 'json', '--wait', '--key', '/key path/key.p8', '--key-id', 'test-key', '--issuer', 'test-issuer'];
  const r = spawnSync(join(shimDir, 'xcrun'), args, { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [...args, '--no-s3-acceleration']);
  assert.equal(r.stderr, 'tool stderr');
});

test('other Apple tools and notarization queries keep their arguments and failure status', unix, t => {
  const { shimDir } = fixture(t);
  for (const args of [['notarytool', 'log', 'submission'], ['notarytool', 'info', 'submission'], ['stapler', 'staple', '-v', 'MyAgents.app'], ['--find', 'clang'], []]) {
    const r = spawnSync(join(shimDir, 'xcrun'), args, { encoding: 'utf8', env: { ...process.env, TOOL_EXIT: '23' } });
    assert.equal(r.status, 23);
    assert.deepEqual(JSON.parse(r.stdout), args);
  }
  const failed = spawnSync(join(shimDir, 'xcrun'), ['notarytool', 'submit', 'app.zip'], { encoding: 'utf8', env: { ...process.env, TOOL_EXIT: '17' } });
  assert.equal(failed.status, 17);
});

test('release invocation scopes the dispatcher to Tauri for both architectures', unix, t => {
  const { root } = fixture(t);
  const tools = join(root, 'tools');
  mkdirSync(tools);
  // A broken PATH binding must fail offline, never invoke the host notarytool.
  writeFileSync(join(tools, 'xcrun'), '#!/bin/bash\nexec "$(dirname "$0")/../system-xcrun" "$@"\n');
  chmodSync(join(tools, 'xcrun'), 0o755);
  writeFileSync(join(tools, 'npm'), '#!/bin/bash\nexec xcrun notarytool submit "$5" --output-format json --wait\n');
  chmodSync(join(tools, 'npm'), 0o755);
  const invocation = build.split('\n').find(line => line.includes('npm run tauri:build:prepared'));
  assert.ok(invocation);
  for (const target of ['aarch64-apple-darwin', 'x86_64-apple-darwin']) {
    const r = spawnSync('bash', ['-c', `${invocation}\n[[ "$PATH" == "$ORIGINAL_PATH" ]]`], {
      encoding: 'utf8', env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, ORIGINAL_PATH: `${tools}:${process.env.PATH}`, PROJECT_DIR: root, TARGET: target, BUILD_ASSETS_CONFIG: '{}' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), ['notarytool', 'submit', target, '--output-format', 'json', '--wait', '--no-s3-acceleration']);
  }
});

test('a target completes only after Tauri, signature, ticket and Gatekeeper succeed', unix, t => {
  const { root } = fixture(t);
  const tools = join(root, 'tools');
  mkdirSync(tools);
  for (const name of ['npm', 'codesign', 'xcrun', 'spctl']) {
    writeFileSync(join(tools, name), `#!/bin/bash\nprintf '${name}\\n' >> "$CALL_LOG"\n[[ "$FAIL_TOOL" != '${name}' ]] || exit 42\n`);
    chmodSync(join(tools, name), 0o755);
  }
  const start = build.indexOf('    PATH="${PROJECT_DIR}/scripts/macos-notary-tools:');
  const end = build.indexOf('    echo -e "${GREEN}✓ $TARGET 构建完成', start);
  assert.ok(start >= 0 && end > start);
  const block = build.slice(start, end);
  for (const fail of ['', 'npm', 'codesign', 'xcrun', 'spctl']) {
    const log = join(root, `calls-${fail}`);
    const r = spawnSync('bash', ['-c', `set -e\n${block}\nprintf 'complete'`], {
      encoding: 'utf8', env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, PROJECT_DIR: root, TARGET: 'x86_64-apple-darwin', BUILD_ASSETS_CONFIG: '{}', CALL_LOG: log, FAIL_TOOL: fail },
    });
    assert.equal(r.status, fail ? 42 : 0, r.stderr);
    assert.equal(r.stdout, fail ? '' : 'complete');
    const expected = ['npm', 'codesign', 'xcrun', 'spctl'];
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), fail ? expected.slice(0, expected.indexOf(fail) + 1) : expected);
  }
});
