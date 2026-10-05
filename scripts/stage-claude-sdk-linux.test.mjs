import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { stageClaudeSdkLinux } from './stage-claude-sdk-linux.mjs';

const wrapper = '@anthropic-ai/claude-agent-sdk';
const native = `${wrapper}-linux-x64`;

function put(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

test('Linux SDK staging follows the pinned package and preserves the prior binary on mismatch', t => {
  const root = mkdtempSync(join(tmpdir(), 'myagents-linux-sdk-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const version = '0.3.284';
  put(join(root, 'package.json'), JSON.stringify({ dependencies: { [wrapper]: version }, optionalDependencies: { [native]: version } }));
  put(join(root, 'package-lock.json'), JSON.stringify({ packages: {
    [`node_modules/${wrapper}`]: { version }, [`node_modules/${native}`]: { version },
  } }));
  for (const name of [wrapper, native]) {
    put(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
  }
  const binary = Buffer.alloc(1024 * 1024 + 1);
  binary.writeUInt32BE(0x7f454c46, 0);
  binary[4] = 2;
  binary[5] = 1;
  binary.writeUInt16LE(62, 18);
  const source = join(root, 'node_modules', native, 'claude');
  put(source, binary);
  chmodSync(source, 0o755);
  const destination = join(root, 'src-tauri/resources/claude-agent-sdk/claude');
  stageClaudeSdkLinux(root);
  assert.deepEqual(readFileSync(destination), binary);

  put(join(root, 'node_modules', native, 'package.json'), JSON.stringify({ name: native, version: '0.3.281' }));
  assert.throws(() => stageClaudeSdkLinux(root), /not installed at 0\.3\.284/);
  assert.deepEqual(readFileSync(destination), binary);
});
