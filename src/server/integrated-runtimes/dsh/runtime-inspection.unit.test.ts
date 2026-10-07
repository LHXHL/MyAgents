import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import dshLock from '../../../shared/integrated-runtimes/dsh-lock.json';

const mocks = vi.hoisted(() => ({ node: null as string | null }));
vi.mock('../../utils/runtime', () => ({ getBundledNodePath: () => mocks.node }));
import { DshRuntime } from './runtime';

let scratch: string;
beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'dsh-diagnose-')));
  mocks.node = null;
});
afterEach(async () => { await rm(scratch, { recursive: true, force: true }); });

async function installFixture() {
  const dsh = join(scratch, 'integrated-runtimes/dsh');
  const artifact = join(dsh, 'runtime-artifact');
  mocks.node = join(scratch, 'nodejs/bin/node');
  await mkdir(artifact, { recursive: true });
  await mkdir(join(scratch, 'nodejs/bin'), { recursive: true });
  await Promise.all([
    writeFile(mocks.node, 'synthetic executable'),
    writeFile(join(artifact, dshLock.runtime.entrypoint), ''),
    writeFile(join(artifact, 'package.json'), '{}'),
  ]);
}

describe('DSH standalone inspection', () => {
  it('distinguishes missing resources from an absent Session without creating a process', async () => {
    const runtime = new DshRuntime();
    const start = vi.spyOn(runtime, 'startSession');
    expect(await runtime.inspectRuntime()).toMatchObject({ installed: false, resources: { state: 'unavailable' }, process: { state: 'not_running' }, model: null, proxy: null });
    await installFixture();
    expect(await runtime.inspectRuntime()).toMatchObject({ installed: true, version: dshLock.dsh.version, resources: { state: 'available', installedIdentity: null }, process: { state: 'not_running' }, permissions: null });
    expect(start).not.toHaveBeenCalled();
  });
  it('projects the installed manifest identity rather than the expected build identity', async () => {
    await installFixture();
    const dsh = join(scratch, 'integrated-runtimes/dsh');
    const runtimeBytes = JSON.stringify({ runtimeVersion: 'fixture-runtime', dsh: { artifactVersion: 'fixture-dsh' },
      build: { repositoryHead: 'a'.repeat(40), toolchain: { node: '24.20.0' } } });
    const handoffBytes = JSON.stringify({ runtime: { path: 'runtime-artifact', manifestSha256: 'b'.repeat(64) } });
    await Promise.all([
      writeFile(join(dsh, 'runtime-artifact/runtime-artifact-v1.json'), runtimeBytes),
      writeFile(join(dsh, 'batch-3-integration-handoff-v1.json'), handoffBytes),
    ]);
    const result = await new DshRuntime().inspectRuntime();
    expect(result).toMatchObject({ installed: true, resources: { state: 'available', installedIdentity: {
      runtimeVersion: 'fixture-runtime', dshVersion: 'fixture-dsh', sourceCommit: 'a'.repeat(40), requiredNodeVersion: '24.20.0',
      handoffSha256: createHash('sha256').update(handoffBytes).digest('hex'),
      runtimeManifestSha256: createHash('sha256').update(runtimeBytes).digest('hex'),
    } }, process: { state: 'not_running' } });
  });

  it.each(['missing', 'malformed', 'incomplete', 'incomplete-handoff'])('keeps installed resources available when identity manifests are %s', async (kind) => {
    await installFixture();
    const dsh = join(scratch, 'integrated-runtimes/dsh');
    if (kind !== 'missing') {
      await Promise.all([
        writeFile(join(dsh, 'batch-3-integration-handoff-v1.json'), '{}'),
        writeFile(join(dsh, 'runtime-artifact/runtime-artifact-v1.json'), kind === 'malformed' ? '{' : kind === 'incomplete-handoff'
          ? JSON.stringify({ runtimeVersion: 'fixture-runtime', dsh: { artifactVersion: 'fixture-dsh' }, build: { repositoryHead: 'a'.repeat(40), toolchain: { node: '24.20.0' } } }) : '{}'),
      ]);
    }
    expect(await new DshRuntime().inspectRuntime()).toMatchObject({ installed: true,
      resources: { state: 'available', code: 'dsh_identity_unavailable', installedIdentity: null }, process: { state: 'not_running' } });
  });

  it.skipIf(process.platform === 'win32')('keeps escaped identity manifests unknown without marking the runtime unavailable', async () => {
    await installFixture();
    const dsh = join(scratch, 'integrated-runtimes/dsh');
    const outside = join(scratch, 'outside-manifest.json');
    await writeFile(outside, '{}');
    await symlink(outside, join(dsh, 'batch-3-integration-handoff-v1.json'));
    await writeFile(join(dsh, 'runtime-artifact/runtime-artifact-v1.json'), '{}');
    const runtime = new DshRuntime();
    expect(await runtime.inspectRuntime()).toMatchObject({ installed: true,
      resources: { state: 'available', code: 'dsh_identity_unavailable', installedIdentity: null } });
    expect(await runtime.detect()).toMatchObject({ installed: true });
  });

  it('reports missing resources after a previous available inspection', async () => {
    await installFixture();
    const runtime = new DshRuntime();
    await runtime.inspectRuntime();
    await rm(join(scratch, 'integrated-runtimes/dsh/runtime-artifact', dshLock.runtime.entrypoint));
    const result = await runtime.inspectRuntime();
    expect(result).toMatchObject({ installed: false, resources: { state: 'unavailable', code: 'dsh_resources_unavailable', installedIdentity: null } });
  });
});
