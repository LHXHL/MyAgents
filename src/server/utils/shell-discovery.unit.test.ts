import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shell = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('child_process', () => ({ execFile: shell.execFile }));
vi.mock('./runtime', () => ({ getBundledNodeDir: () => null }));

describe('external CLI shell discovery', () => {
  beforeEach(() => {
    vi.resetModules();
    shell.execFile.mockReset();
    vi.stubEnv('HOME', '/myagents-test-no-home');
    vi.stubEnv('PATH', '/inherited/bin:/usr/bin');
  });
  afterEach(() => vi.unstubAllEnvs());

  it.runIf(process.platform !== 'win32')('first use starts discovery and waits for user PATH ahead of fallback', async () => {
    const { ensureShellPath, getShellPath } = await import('./shell');
    const discovering = ensureShellPath();
    expect(shell.execFile).toHaveBeenCalledTimes(1);
    const [, args, , complete] = shell.execFile.mock.calls[0];
    expect(args.slice(0, 3)).toEqual(['-i', '-l', '-c']);
    const selected = '/user-selected-node/bin';
    complete(null, `banner\n__MYAGENTS_PATH_${process.pid}__${selected}:/opt/homebrew/bin:/usr/bin__MYAGENTS_PATH_${process.pid}__\n`);
    expect((await discovering).split(':').slice(0, 3)).toEqual([selected, '/opt/homebrew/bin', '/usr/bin']);
    expect(getShellPath().split(':')[0]).toBe(selected);
    await ensureShellPath();
    expect(shell.execFile).toHaveBeenCalledTimes(1);
  });

  it.runIf(process.platform !== 'win32')('failed discovery completes using inherited PATH and remains usable', async () => {
    const { buildFallbackPath, ensureShellPath } = await import('./shell');
    const discovering = ensureShellPath();
    const complete = shell.execFile.mock.calls[0][3];
    complete(new Error('shell timeout'), '');
    expect(await discovering).toBe(buildFallbackPath());
    await ensureShellPath();
    expect(shell.execFile).toHaveBeenCalledTimes(1);
  });
});
