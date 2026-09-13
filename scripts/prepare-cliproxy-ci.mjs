// Public CI consumes a versioned, signed release snapshot rather than mutable
// remote policy or a maintainer's private cache. No signing key is needed.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectBundledRelease } from './cliproxy-release-policy.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function ciArtifact(manifest, source, pkg, platform) {
  const component = selectBundledRelease(manifest.releases, pkg.version, source);
  const artifact = component?.artifacts?.[platform];
  if (!source.platforms[platform] || !artifact
    || component.version !== source.version || component.commit !== source.commit
    || component.tag !== source.tag || artifact.sourceSha256 !== source.platforms[platform].sha256) {
    throw new Error('CI CLIProxy snapshot must match the source and minimum App policy; update the signed snapshot');
  }
  if (!/^[0-9a-f]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.size)
    || artifact.size <= 0 || artifact.size > 128 * 1024 * 1024
    || artifact.url !== `https://download.myagents.io/runtimes/cliproxy/${source.version}-${platform}-${artifact.sha256}.zip`) {
    throw new Error('Invalid immutable CI CLIProxy artifact');
  }
  return artifact;
}

export async function fetchArtifact(artifact, fetchImpl = fetch) {
  const response = await fetchImpl(artifact.url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`CLIProxy artifact download failed (${response.status})`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > artifact.size) throw new Error('CLIProxy artifact exceeds its signed size');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (size !== artifact.size || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
    throw new Error('CLIProxy artifact integrity mismatch');
  }
  return bytes;
}

async function main() {
  const platform = process.argv[2] ?? `${process.platform}-${process.arch}`;
  const snapshot = join(repo, '.github/cliproxy');
  const manifest = readFileSync(join(snapshot, 'manifest-v1.json'));
  const signature = readFileSync(join(snapshot, 'manifest-v1.json.sig'));
  const artifact = ciArtifact(JSON.parse(manifest),
    JSON.parse(readFileSync(join(repo, 'src/shared/managed-cliproxy-source.json'))),
    JSON.parse(readFileSync(join(repo, 'package.json'))), platform);
  const bytes = await fetchArtifact(artifact);
  const out = join(repo, 'src-tauri/resources/cliproxy');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'manifest-v1.json'), manifest);
  writeFileSync(join(out, 'manifest-v1.json.sig'), signature);
  writeFileSync(join(out, 'artifact.zip'), bytes);
  // build_cliproxy.rs performs the unchanged cryptographic verification before
  // compilation. These downloaded bytes are never executed by this script.
  console.log(`Prepared signed ${platform} CLIProxy build inputs`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
