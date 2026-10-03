import { afterEach, describe, expect, it, vi } from 'vitest';
import packageJson from '../../package.json';
const git = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFileSync: git }));
const originalEntry = process.argv[1];
afterEach(() => { process.argv[1] = originalEntry; vi.resetModules(); vi.unstubAllEnvs(); });
describe('Sidecar startup identity', () => {
  it('uses the source package version and retains startup identity after Git changes', async () => {
    vi.resetModules();
    process.argv[1] = '/synthetic/repo/src/server/index.ts';
    git.mockImplementation((_command, args: string[]) => args[0] === 'rev-parse' ? 'initial-commit\n' : ' M src/server/index.ts\n');
    vi.stubEnv('MYAGENTS_APP_VERSION', 'launcher-version');
    const initial = await import('./build-identity');
    expect(initial.SIDECAR_BUILD_IDENTITY).toMatchObject({ version: packageJson.version, mode: 'source', commit: 'initial-commit', dirty: true });
    expect(initial.APP_BUILD_IDENTITY.version).toBe('launcher-version');
    git.mockReturnValue('new-checkout');
    expect((await import('./build-identity')).SIDECAR_BUILD_IDENTITY).toBe(initial.SIDECAR_BUILD_IDENTITY);
    expect(git).toHaveBeenCalledTimes(2);
  });
});
