import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
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
  it('reports missing resources after a previous available inspection', async () => {
    await installFixture();
    const runtime = new DshRuntime();
    await runtime.inspectRuntime();
    await rm(join(scratch, 'integrated-runtimes/dsh/runtime-artifact', dshLock.runtime.entrypoint));
    const result = await runtime.inspectRuntime();
    expect(result).toMatchObject({ installed: false, resources: { state: 'unavailable', code: 'dsh_resources_unavailable', installedIdentity: null } });
  });
});
