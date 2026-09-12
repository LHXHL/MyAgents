import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkArchive, validateApproval } from './package-cliproxy-component.mjs';
import { assertPublicationRevision, publicationPlan } from './publish-cliproxy-component.mjs';

const source = JSON.parse(readFileSync(new URL('../src/shared/managed-cliproxy-source.json', import.meta.url)));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const bytes = Buffer.from('synthetic packaging fixture, never an executable');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const record = platform => ({ platform, version: source.version, commit: source.commit, platformSigning: 'ad-hoc',
  artifact: { sourceSha256: source.platforms[platform].sha256, sha256, size: bytes.length,
    url: `https://download.myagents.io/runtimes/cliproxy/${source.version}-${platform}-${sha256}.zip` } });
const approval = () => ({ controls: { policyRevision: 1, providerMode: 'internal', revokedArtifacts: [], revokedVersions: [] },
  compatibility: { appVersions: [pkg.version], sdkVersion: pkg.dependencies['@anthropic-ai/claude-agent-sdk'], revision: 1,
    credentialCompatibleVersions: [], models: [] } });

test('source size and digest both gate packaging', () => {
  checkArchive(bytes, { size: bytes.length, sha256 });
  assert.throws(() => checkArchive(bytes, { size: bytes.length + 1, sha256 }));
  assert.throws(() => checkArchive(Buffer.from('modified'), { size: bytes.length, sha256 }));
});
test('internal work does not accidentally become public model approval', () => {
  const input = approval();
  const manifest = validateApproval(input, [record('darwin-arm64')]);
  assert.deepEqual(manifest.component.compatibility.models, []);
  input.controls.providerMode = 'enabled';
  assert.throws(() => validateApproval(input, [record('darwin-arm64')]));
  input.compatibility.models = [{ id: 'synthetic-only', tools: true, thinking: false, inputModalities: ['text'], outputModalities: ['text'] }];
  assert.throws(() => validateApproval(input, Object.keys(source.platforms).map(record)));
});
test('duplicate platform and incompatible App/SDK records are rejected', () => {
  assert.throws(() => validateApproval(approval(), [record('darwin-arm64'), record('darwin-arm64')]));
  const input = approval(); input.compatibility.sdkVersion = '0.0.0';
  assert.throws(() => validateApproval(input, [record('darwin-arm64')]));
});
test('publication plans bind immutable URLs to the exact reviewed artifact bytes', () => {
  const manifest = validateApproval(approval(), [record('darwin-arm64')]);
  assert.equal(publicationPlan(manifest, () => bytes).files.length, 1);
  assert.throws(() => publicationPlan(manifest, () => Buffer.from('modified')));
  manifest.component.artifacts['darwin-arm64'].url = 'https://other.test/artifact.zip';
  assert.throws(() => publicationPlan(manifest, () => bytes));
});
test('publication cannot undo a policy or silently replace a compatibility revision', () => {
  const old = validateApproval(approval(), [record('darwin-arm64')]);
  const next = structuredClone(old); next.controls.providerMode = 'disabled';
  assert.throws(() => assertPublicationRevision(old, next));
  next.controls.policyRevision++;
  assert.doesNotThrow(() => assertPublicationRevision(old, next));
  next.component.compatibility.models = [{ id: 'different' }];
  assert.throws(() => assertPublicationRevision(old, next));
  next.component.compatibility.revision++;
  assert.doesNotThrow(() => assertPublicationRevision(old, next));
  assert.throws(() => assertPublicationRevision(next, old));
});
