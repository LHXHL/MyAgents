import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import dshLock from '../../../shared/integrated-runtimes/dsh-lock.json';

const mocks = vi.hoisted(() => ({ node: null as string | null, verify: vi.fn() }));
vi.mock('../../utils/runtime', () => ({ getBundledNodePath: () => mocks.node }));
vi.mock('./installation', async importOriginal => ({
  ...await importOriginal<typeof import('./installation')>(), verifyDshHandoffInstallation: mocks.verify,
}));
import { DshRuntime } from './runtime';

let scratch: string;
beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'dsh-diagnose-')));
  mocks.node = null;
  mocks.verify.mockReset().mockResolvedValue(undefined);
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
    writeFile(join(dsh, 'verify.mjs'), ''),
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
    expect(await runtime.inspectRuntime()).toMatchObject({ installed: true, resources: { state: 'verified', installedIdentity: { sourceCommit: dshLock.handoff.sourceCommit } }, process: { state: 'not_running' }, permissions: null });
    expect(mocks.verify).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
  });
  it('reverifies resources on each inspection and excludes verifier error text', async () => {
    await installFixture();
    const runtime = new DshRuntime();
    await runtime.inspectRuntime();
    mocks.verify.mockRejectedValue(new Error('synthetic-private-verifier-output'));
    const result = await runtime.inspectRuntime();
    expect(result).toMatchObject({ installed: true, resources: { state: 'verification_failed', code: 'dsh_handoff_verification_failed', installedIdentity: null, expectedIdentity: { sourceCommit: dshLock.handoff.sourceCommit } } });
    expect(JSON.stringify(result)).not.toContain('synthetic-private-verifier-output');
    expect(mocks.verify).toHaveBeenCalledTimes(2);
  });
});
