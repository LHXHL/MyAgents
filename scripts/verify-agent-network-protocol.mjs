import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Validate the committed distribution input; npm installs its locked content. */
export async function verifyAgentNetworkProtocol(root = fileURLToPath(new URL('../', import.meta.url))) {
  const dir = resolve(root, 'vendor/agent-network-protocol');
  const manifest = JSON.parse(await readFile(resolve(dir, 'manifest.json'), 'utf8'));
  const name = '@myagents/agent-network-protocol';
  if (manifest.package !== name || !/^\d+\.\d+\.\d+$/.test(manifest.version)
    || !/^[a-f0-9]{64}$/.test(manifest.sha256)
    || manifest.file !== `myagents-agent-network-protocol-${manifest.version}-${manifest.sha256.slice(0, 16)}.tgz`) {
    throw new Error('Invalid committed AgentNet protocol manifest');
  }
  const digest = createHash('sha256').update(await readFile(resolve(dir, manifest.file))).digest('hex');
  if (digest !== manifest.sha256) throw new Error('AgentNet protocol artifact checksum mismatch');
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
  const spec = `file:vendor/agent-network-protocol/${manifest.file}`;
  if (pkg.dependencies?.[name] !== spec || lock.packages?.['']?.dependencies?.[name] !== spec
    || lock.packages?.[`node_modules/${name}`]?.resolved !== spec
    || lock.packages?.[`node_modules/${name}`]?.version !== manifest.version) {
    throw new Error('Desktop must pin the verified AgentNet protocol artifact in package.json and lockfile');
  }
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await verifyAgentNetworkProtocol();
  console.log(`Verified AgentNet protocol ${manifest.version}: ${manifest.sha256}`);
}
