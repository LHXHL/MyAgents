#!/usr/bin/env node
// Explicit release action. By default, only validate the prepared distribution
// and print a reviewable plan. Credentials are supplied through the existing
// release environment; this script never reads or prints a private signing key.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = 'https://download.myagents.io/runtimes/cliproxy/';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = value => JSON.stringify(value, Object.keys(value).sort());
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`${command} failed; verify the release tool installation and configuration`);
}

export function publicationPlan(manifest, readArtifact) {
  if (manifest.schemaVersion !== 1 || !Number.isSafeInteger(manifest.controls?.policyRevision)
    || manifest.controls.policyRevision < 1 || !['internal', 'disabled', 'enabled'].includes(manifest.controls.providerMode)) throw new Error('Invalid publication controls');
  const artifacts = Object.entries(manifest.component?.artifacts ?? {});
  if (!artifacts.length) throw new Error('No prepared artifacts');
  const files = artifacts.map(([platform, artifact]) => {
    if (!['darwin-arm64', 'darwin-x64', 'win32-x64'].includes(platform)) throw new Error('Unsupported artifact platform');
    const filename = `${manifest.component.version}-${platform}-${artifact.sha256}.zip`;
    if (!/^[0-9a-f]{64}$/.test(artifact.sha256) || artifact.url !== base + filename) throw new Error('Artifact must use its immutable digest URL');
    const bytes = readArtifact(filename);
    if (bytes.length !== artifact.size || sha256(bytes) !== artifact.sha256) throw new Error('Prepared artifact does not match the signed manifest');
    return { filename, size: artifact.size, sha256: artifact.sha256 };
  });
  return { mode: manifest.controls.providerMode, policyRevision: manifest.controls.policyRevision,
    version: manifest.component.version, files };
}

export function assertPublicationRevision(previous, incoming) {
  if (previous.controls.policyRevision > incoming.controls.policyRevision
    || (previous.controls.policyRevision === incoming.controls.policyRevision && plain(previous.controls) !== plain(incoming.controls))) {
    throw new Error('Publication would roll back or conflict with signed controls');
  }
  if (previous.component.version === incoming.component.version
    && (previous.component.compatibility.revision > incoming.component.compatibility.revision
      || (previous.component.compatibility.revision === incoming.component.compatibility.revision
        && JSON.stringify(previous.component.compatibility) !== JSON.stringify(incoming.component.compatibility)))) {
    throw new Error('Compatibility changes require a higher compatibility revision');
  }
}

async function fetchBytes(url, limit, allowMissing = false) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120_000), cache: 'no-store' });
  if (allowMissing && response.status === 404) return null;
  if (!response.ok) throw new Error('Published resource is not reachable');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('Published resource exceeds its size bound');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function main() {
  const args = process.argv.slice(2);
  if (!args[0] || args.some((arg, index) => index > 0 && arg !== '--publish')) throw new Error('Usage: publish-cliproxy-component.mjs <distribution-dir> [--publish]');
  const distribution = resolve(args[0]);
  const manifestPath = join(distribution, 'manifest-v1.json');
  const bytes = readFileSync(manifestPath);
  const signature = readFileSync(`${manifestPath}.sig`, 'utf8').trim();
  if (bytes.length > 256 * 1024 || signature.length > 16 * 1024) throw new Error('Oversized manifest/signature');
  const scratch = mkdtempSync(join(tmpdir(), 'myagents-cliproxy-publish-'));
  try {
    const config = JSON.parse(readFileSync(join(repo, 'src-tauri/tauri.conf.json'), 'utf8'));
    const publicKey = Buffer.from(config.plugins.updater.pubkey, 'base64').toString('utf8').split(/\r?\n/).find(line => line.startsWith('RW'));
    if (!publicKey) throw new Error('The existing updater trust root is missing');
    const verify = (content, wrapped) => {
      writeFileSync(join(scratch, 'manifest'), content);
      writeFileSync(join(scratch, 'signature'), Buffer.from(wrapped, 'base64'));
      run('minisign', ['-Vm', join(scratch, 'manifest'), '-x', join(scratch, 'signature'), '-P', publicKey]);
    };
    verify(bytes, signature);
    const manifest = JSON.parse(bytes);
    const plan = publicationPlan(manifest, name => readFileSync(join(distribution, name)));
    console.log(JSON.stringify({ action: args.includes('--publish') ? 'publish' : 'review-only', ...plan }, null, 2));
    if (!args.includes('--publish')) return;
    for (const key of ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID', 'CF_ZONE_ID', 'CF_API_TOKEN']) {
      if (!process.env[key]) throw new Error(`Missing release environment ${key}`);
    }
    if (!/^[a-f0-9]{32}$/i.test(process.env.R2_ACCOUNT_ID) || !/^[a-f0-9]{32}$/i.test(process.env.CF_ZONE_ID)) throw new Error('Invalid release account/zone identifier');
    const prior = await fetchBytes(base + 'manifest-v1.json', 256 * 1024, true);
    if (prior) {
      const priorSignature = await fetchBytes(base + 'manifest-v1.json.sig', 16 * 1024);
      verify(prior, priorSignature.toString('utf8').trim());
      assertPublicationRevision(JSON.parse(prior), manifest);
    }
    const env = { ...process.env, RCLONE_CONFIG_CLIPROXY_TYPE: 's3', RCLONE_CONFIG_CLIPROXY_PROVIDER: 'Cloudflare',
      RCLONE_CONFIG_CLIPROXY_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
      RCLONE_CONFIG_CLIPROXY_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
      RCLONE_CONFIG_CLIPROXY_ENDPOINT: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` };
    delete env.TAURI_SIGNING_PRIVATE_KEY; delete env.TAURI_PRIVATE_KEY;
    const upload = (name, immutable) => run('rclone', ['copyto', join(distribution, name),
      `cliproxy:myagents-releases/runtimes/cliproxy/${name}`, '--s3-no-check-bucket', ...(immutable ? ['--immutable'] : [])], env);
    for (const file of plan.files) {
      upload(file.filename, true);
      const published = await fetchBytes(base + file.filename, file.size);
      if (published.length !== file.size || sha256(published) !== file.sha256) throw new Error('Published artifact integrity mismatch');
    }
    // Readers fail closed on a transient mismatched pair and retain their last
    // trusted approval. Both mutable objects are purged only after both writes.
    upload('manifest-v1.json.sig', false); upload('manifest-v1.json', false);
    const purge = await fetch(`https://api.cloudflare.com/client/v4/zones/${process.env.CF_ZONE_ID}/purge_cache`, {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [base + 'manifest-v1.json', base + 'manifest-v1.json.sig'] }), signal: AbortSignal.timeout(30_000),
    });
    if (!purge.ok || (await purge.json()).success !== true) throw new Error('Published manifest CDN purge was not confirmed');
    const published = await fetchBytes(base + 'manifest-v1.json', 256 * 1024);
    const publishedSignature = await fetchBytes(base + 'manifest-v1.json.sig', 16 * 1024);
    verify(published, publishedSignature.toString('utf8').trim());
    if (sha256(published) !== sha256(bytes)) throw new Error('Published manifest differs from the reviewed distribution');
    console.log('Published CLIProxy distribution and verified all public bytes.');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
