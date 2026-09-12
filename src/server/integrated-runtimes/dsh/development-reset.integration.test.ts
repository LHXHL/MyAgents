import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDshBinding } from '../../../shared/integrated-runtimes/identity';
import { createSessionMetadata } from '../../types/session';
import { applyDshDevelopmentReset, isDshDevelopmentWriterCommand, planDshDevelopmentReset } from './development-reset';
import { dshSessionOwnedPaths } from './owned-paths';

const scratch = vi.hoisted(() => ({ home: '' }));
vi.mock('os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), homedir: () => scratch.home }));
let root: string;
let store: typeof import('../../SessionStore');
const oldBinding = () => {
  const binding = createDshBinding('darwin-arm64');
  if (binding.family !== 'integrated' || binding.id !== 'dsh') throw new Error('Expected DSH fixture binding');
  return { ...binding, protocolVersion: '4.0.0', implementationVersion: '0.1.2-rc.1' };
};
const put = async (path: string, text = 'synthetic bytes') => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
};
const missing = async (path: string) => expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });

beforeEach(async () => {
  scratch.home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-development-reset-')));
  root = join(scratch.home, '.myagents');
  vi.resetModules();
  store = await import('../../SessionStore');
});
afterEach(async () => { await rm(scratch.home, { recursive: true, force: true }); });

async function fixture(id = 'old-dsh') {
  const metadata = createSessionMetadata(join(scratch.home, 'workspace'), { id, runtimeBinding: oldBinding(), runtime: 'dsh' });
  await store.saveSessionMetadata(metadata);
  await put(join(root, 'sessions', `${id}.jsonl`), '{"role":"user","content":"synthetic old projection"}\n');
  const paths = dshSessionOwnedPaths(root, id);
  await Promise.all([
    put(join(paths.runtimeHome, 'session.sqlite')),
    put(join(paths.runtimeHome, 'session.sqlite-wal')),
    put(join(paths.runtimeHome, 'session.sqlite-shm')),
    put(join(paths.runtimeHome, 'checkpoints', 'file')),
    put(join(paths.attachmentRoot, 'objects', 'a'.repeat(64))),
    put(join(root, 'attachments', id, 'upload.txt')),
    put(join(root, 'generated', 'tool-attachments', id, 'turn-1', 'result.txt')),
  ]);
  return { metadata, paths };
}

describe('one-time unreleased DSH development reset', () => {
  it('recognizes actual app, bundled Sidecar, development and Runtime process commands', () => {
    for (const command of ['/Applications/MyAgents.app/Contents/MacOS/MyAgents',
      'node /app/server-dist.js --port 4000', 'node /project/src/server/index.ts',
      'node /app/server/index.ts', 'node /artifact/runtime-server-process.artifact.mjs',
      String.raw`C:\App\MyAgents.exe --dev`, String.raw`node C:\App\server-dist.js`]) {
      expect(isDshDevelopmentWriterCommand(command), command).toBe(true);
    }
    expect(isDshDevelopmentWriterCommand('node scripts/reset-dsh-development-sessions.ts')).toBe(false);
    expect(isDshDevelopmentWriterCommand('node /tools/codex.js')).toBe(false);
  });

  it('uses real SessionStore deletion, preserves other authorities and is idempotent', async () => {
    const old = await fixture();
    const other = createSessionMetadata(join(scratch.home, 'workspace'), { id: 'other-runtime' });
    const current = createSessionMetadata(join(scratch.home, 'workspace'), { id: 'new-dsh', runtimeBinding: { ...oldBinding(), protocolVersion: '5.0.0' }, runtime: 'dsh' });
    await store.saveSessionMetadata(other);
    await store.saveSessionMetadata(current);
    const markers = [join(root, 'config.json'), join(root, 'credentials', 'fixture'), join(scratch.home, 'workspace', 'keep.txt'),
      join(root, 'sessions', 'other-runtime.jsonl'), join(root, 'sessions', 'new-dsh.jsonl'), join(root, 'other-runtime', 'keep')];
    for (const path of markers) await put(path, JSON.stringify({ content: 'preserved synthetic bytes' }));
    const plan = await planDshDevelopmentReset(root);
    expect(plan.sessions.map(session => session.id)).toEqual(['old-dsh']);
    expect(JSON.stringify(plan)).not.toContain('synthetic old projection');
    const stopped = vi.fn(() => Promise.resolve());
    await expect(applyDshDevelopmentReset(plan, store.resetDshDevelopmentSession, stopped)).resolves.toMatchObject({ deleted: 1 });
    expect(stopped).toHaveBeenCalledTimes(2);
    await missing(join(old.paths.runtimeHome, 'session.sqlite'));
    await missing(join(old.paths.runtimeHome, 'session.sqlite-wal'));
    await missing(join(old.paths.attachmentRoot, 'objects', 'a'.repeat(64)));
    await missing(join(root, 'sessions', 'old-dsh.jsonl'));
    await missing(join(root, 'attachments', 'old-dsh', 'upload.txt'));
    for (const path of markers) expect(await readFile(path, 'utf8')).toBe(JSON.stringify({ content: 'preserved synthetic bytes' }));
    expect(store.getAllSessionMetadata().map(session => session.id).sort()).toEqual(['new-dsh', 'other-runtime']);
    const empty = await planDshDevelopmentReset(root);
    await expect(applyDshDevelopmentReset(empty, store.resetDshDevelopmentSession, stopped)).resolves.toMatchObject({ deleted: 0 });
  });

  it('preserves shared attachment references and never follows external savedPath', async () => {
    await fixture();
    await store.saveSessionMetadata(createSessionMetadata(scratch.home, { id: 'survivor' }));
    const shared = join(root, 'attachments', 'old-dsh', 'upload.txt');
    const external = join(scratch.home, 'workspace', 'saved.txt');
    await put(external, 'external user file');
    await put(join(root, 'sessions', 'survivor.jsonl'), `${JSON.stringify({ role: 'tool', savedPath: shared })}\n`);
    await put(join(root, 'sessions', 'old-dsh.jsonl'), `${JSON.stringify({ role: 'tool', savedPath: external })}\n`);
    const plan = await planDshDevelopmentReset(root);
    expect(plan.sessions[0].preserveShared).toEqual([join(root, 'attachments', 'old-dsh')]);
    await applyDshDevelopmentReset(plan, store.resetDshDevelopmentSession, () => Promise.resolve());
    expect(await readFile(shared, 'utf8')).toBe('synthetic bytes');
    expect(await readFile(external, 'utf8')).toBe('external user file');
  });

  it('preserves raw legacy sibling metadata without adding bindings or normalizing Provider fields', async () => {
    const old = await fixture();
    const builtin = createSessionMetadata(scratch.home, { id: 'legacy-builtin' });
    delete builtin.runtimeBinding;
    const managed = { ...builtin, id: 'legacy-managed', runtime: 'codex', runtimeSource: 'managed-provider',
      providerRoute: { providerId: 'synthetic-legacy-route' }, providerEnvJson: 'synthetic retained metadata' };
    const survivors = [builtin, managed];
    const path = join(root, 'sessions.json');
    await writeFile(path, JSON.stringify([old.metadata, ...survivors]));
    const plan = await planDshDevelopmentReset(root);
    await expect(applyDshDevelopmentReset(plan, store.resetDshDevelopmentSession, () => Promise.resolve())).resolves.toMatchObject({ deleted: 1 });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(survivors);
    expect((await planDshDevelopmentReset(root)).sessions).toEqual([]);
  });

  it('rejects links anywhere in a selected tree before deleting any Session', async () => {
    const first = await fixture('first-dsh');
    const second = await fixture('second-dsh');
    const external = join(scratch.home, 'workspace');
    await put(join(external, 'keep.txt'));
    await symlink(external, join(second.paths.runtimeHome, 'linked-workspace'));
    await expect(planDshDevelopmentReset(root)).rejects.toThrow('links');
    expect(await readFile(join(first.paths.runtimeHome, 'session.sqlite'), 'utf8')).toBe('synthetic bytes');
    expect(await readFile(join(external, 'keep.txt'), 'utf8')).toBe('synthetic bytes');
  });

  it('refuses a stale plan or active process before owned data removal', async () => {
    const old = await fixture();
    const plan = await planDshDevelopmentReset(root);
    await expect(applyDshDevelopmentReset(plan, store.resetDshDevelopmentSession, () => Promise.reject(new Error('active process')))).rejects.toThrow('active process');
    await store.saveSessionMetadata(createSessionMetadata(scratch.home, { id: 'new-other' }));
    await expect(applyDshDevelopmentReset(plan, store.resetDshDevelopmentSession, () => Promise.resolve())).rejects.toThrow('plan changed');
    expect(await readFile(join(old.paths.runtimeHome, 'session.sqlite'), 'utf8')).toBe('synthetic bytes');
  });

  it('rechecks binding under real SessionStore locks before cleanup and retains failed rows', async () => {
    const old = await fixture();
    const remove = vi.fn(() => Promise.resolve());
    await store.saveSessionMetadata({ ...old.metadata, runtimeBinding: { ...oldBinding(), protocolVersion: '5.0.0' } });
    expect(await store.resetDshDevelopmentSession('old-dsh', old.metadata.runtimeBinding!, remove)).toEqual({ deleted: false, reason: 'precondition-failed' });
    expect(remove).not.toHaveBeenCalled();
    await store.saveSessionMetadata(old.metadata);
    expect(await store.resetDshDevelopmentSession('old-dsh', old.metadata.runtimeBinding!, () => Promise.reject(new Error('synthetic cleanup fault')))).toEqual({ deleted: false, reason: 'io-error' });
    expect(store.getSessionMetadata('old-dsh')).not.toBeNull();
    expect(await readFile(join(root, 'sessions', 'old-dsh.jsonl'), 'utf8')).toContain('synthetic old projection');
  });

  it('preserves retained Task and Goal owners instead of bypassing their lifecycle', async () => {
    const old = await fixture();
    for (const name of ['tasks.jsonl', 'session_goals.json']) {
      const path = join(root, name);
      const value = name.endsWith('.jsonl') ? { sessionIds: ['old-dsh'] } : { goals: [{ sessionId: 'old-dsh' }] };
      await put(path, JSON.stringify(value));
      await expect(planDshDevelopmentReset(root)).rejects.toThrow('Task or Goal');
      expect(await readFile(join(old.paths.runtimeHome, 'session.sqlite'), 'utf8')).toBe('synthetic bytes');
      await rm(path);
    }
  });

  it('rejects invalid identities and unbound DSH rows without interpreting their paths', async () => {
    await fixture();
    const index = join(root, 'sessions.json');
    await writeFile(index, JSON.stringify([{ id: '../outside', runtimeBinding: oldBinding() }]));
    await expect(planDshDevelopmentReset(root)).rejects.toThrow('invalid DSH identity');
    await writeFile(index, JSON.stringify([{ id: 'legacy-dsh', runtime: 'dsh' }]));
    await expect(planDshDevelopmentReset(root)).rejects.toThrow('explicit authoritative');
    expect(() => dshSessionOwnedPaths(root, '../outside')).toThrow('canonical');
  });
});
