import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyAgentNetworkProtocol } from './verify-agent-network-protocol.mjs';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'myagents-protocol-'));
  const name = '@myagents/agent-network-protocol';
  const bytes = Buffer.from('isolated artifact integrity fixture');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const manifest = { package: name, version: '1.0.0', sha256, file: `myagents-agent-network-protocol-1.0.0-${sha256.slice(0, 16)}.tgz` };
  const spec = `file:vendor/agent-network-protocol/${manifest.file}`;
  const pkg = { dependencies: { [name]: spec } };
  const lock = { packages: { '': pkg, [`node_modules/${name}`]: { version: '1.0.0', resolved: spec } } };
  const dir = join(root, 'vendor/agent-network-protocol');
  const save = async () => {
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
    await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock));
  };
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, manifest.file), bytes);
    await save();
    await run({ root, dir, manifest, pkg, lock, save });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('accepts a fixed artifact with matching dependency and lockfile', () => fixture(async ({ root, manifest }) => {
  assert.deepEqual(await verifyAgentNetworkProtocol(root), manifest);
}));
test('rejects altered or missing committed bytes without a network fallback', () => fixture(async ({ root, dir, manifest }) => {
  await writeFile(join(dir, manifest.file), 'changed');
  await assert.rejects(verifyAgentNetworkProtocol(root), /checksum mismatch/);
  await rm(join(dir, manifest.file));
  await assert.rejects(verifyAgentNetworkProtocol(root), /ENOENT/);
}));
test('rejects manifest filename traversal before reading the artifact', () => fixture(async ({ root, manifest, save }) => {
  manifest.file = '../../different-package.tgz'; await save();
  await assert.rejects(verifyAgentNetworkProtocol(root), /Invalid committed/);
}));
test('rejects a stale source dependency or installed lock entry', () => fixture(async ({ root, pkg, lock, save }) => {
  pkg.dependencies['@myagents/agent-network-protocol'] = 'file:packages/agent-network-protocol'; await save();
  await assert.rejects(verifyAgentNetworkProtocol(root), /must pin/);
  pkg.dependencies['@myagents/agent-network-protocol'] = lock.packages['node_modules/@myagents/agent-network-protocol'].resolved;
  lock.packages['node_modules/@myagents/agent-network-protocol'].version = '0.9.0'; await save();
  await assert.rejects(verifyAgentNetworkProtocol(root), /must pin/);
}));
