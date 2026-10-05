import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { verifyClaudeSdkWrapper } from './verify-claude-sdk-wrapper.mjs';

const name = '@anthropic-ai/claude-agent-sdk';
const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-arm64-musl', 'linux-x64', 'linux-x64-musl', 'win32-arm64', 'win32-x64'];

function put(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

test('SDK wrapper verification rejects a stale installed package after a version change', t => {
  const root = mkdtempSync(join(tmpdir(), 'myagents-sdk-wrapper-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(join(root, 'package.json'), { dependencies: { [name]: '0.3.284' }, optionalDependencies: Object.fromEntries(platforms.map(platform => [`${name}-${platform}`, '0.3.284'])) });
  put(join(root, 'package-lock.json'), { packages: Object.fromEntries([name, ...platforms.map(platform => `${name}-${platform}`)].map(packageName => [`node_modules/${packageName}`, { version: '0.3.284' }])) });
  const installedPath = join(root, 'node_modules', name, 'package.json');
  put(installedPath, { name, version: '0.3.281' });
  assert.throws(() => verifyClaudeSdkWrapper(root), /not 0\.3\.284/);
  put(installedPath, { name, version: '0.3.284' });
  assert.equal(verifyClaudeSdkWrapper(root), '0.3.284');
});
