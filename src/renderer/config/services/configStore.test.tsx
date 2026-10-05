import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    copyFile: vi.fn(),
    exists: vi.fn(),
    mkdir: vi.fn(),
    readTextFile: vi.fn(),
    remove: vi.fn(),
    rename: vi.fn(),
    stat: vi.fn(),
    writeTextFile: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
    copyFile: mocks.copyFile,
    exists: mocks.exists,
    mkdir: mocks.mkdir,
    readTextFile: mocks.readTextFile,
    writeTextFile: mocks.writeTextFile,
    remove: mocks.remove,
    rename: mocks.rename,
    stat: mocks.stat,
}));
vi.mock('@tauri-apps/api/path', () => ({
    homeDir: vi.fn(async () => '/home/test'),
    join: vi.fn(async (...parts: string[]) => parts.join('/')),
    dirname: vi.fn(async (path: string) => path.slice(0, path.lastIndexOf('/'))),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@/utils/browserMock', () => ({ isBrowserDevMode: () => false }));

import {
    ProjectsBusyError,
    safeWriteJson,
    withAgentConfigIntentLock,
    withConfigLock,
    withFileLock,
    withProjectsLock,
} from './configStore';

describe('JSON backup replacement', () => {
    beforeEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
        mocks.exists.mockResolvedValue(true);
        mocks.writeTextFile.mockResolvedValue(undefined);
        mocks.rename.mockResolvedValue(undefined);
        mocks.copyFile.mockResolvedValue(undefined);
        mocks.remove.mockRejectedValue(new Error('failed to get metadata of path: ENOENT'));
    });

    it('copies over the previous backup without a separate destructive remove', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            await safeWriteJson('/synthetic/config.json', { enabled: true });
            expect(mocks.copyFile).toHaveBeenCalledWith('/synthetic/config.json', '/synthetic/config.json.bak');
            expect(mocks.remove).not.toHaveBeenCalled();
            expect(warn).not.toHaveBeenCalled();
            expect(mocks.rename).toHaveBeenCalledWith('/synthetic/config.json.tmp', '/synthetic/config.json');
        } finally { warn.mockRestore(); }
    });

    it('still reports a genuine backup copy failure and publishes the main write', async () => {
        const failure = new Error('permission denied');
        mocks.copyFile.mockRejectedValueOnce(failure);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            await safeWriteJson('/synthetic/config.json', {});
            expect(warn).toHaveBeenCalledWith('[configStore] Failed to create .bak backup:', failure);
            expect(mocks.rename).toHaveBeenCalled();
        } finally { warn.mockRestore(); }
    });
});

describe('renderer file lock errors', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        mocks.exists.mockResolvedValue(true);
        mocks.readTextFile.mockResolvedValue('node:123:456\n');
        mocks.remove.mockResolvedValue(undefined);
        mocks.rename.mockResolvedValue(undefined);
        mocks.stat.mockResolvedValue({ mtime: new Date() });
        mocks.writeTextFile.mockResolvedValue(undefined);
        mocks.mkdir.mockImplementation(async (path: string) => {
            if (path.endsWith('.lock')) {
                throw Object.assign(new Error('already exists'), { code: 'EEXIST' });
            }
        });
    });

    it('preserves the concrete lock path in the generic error', async () => {
        const outcome = withFileLock('/home/test/.myagents/providers/custom.json', async () => undefined).catch((error) => error);

        await vi.advanceTimersByTimeAsync(5_100);
        expect(await outcome).toMatchObject({
            code: 'FILE_BUSY',
            lockPath: '/home/test/.myagents/providers/custom.json.lock',
        });
    });

    it('does not misreport a filesystem failure as lock contention', async () => {
        const permissionError = new Error('permission denied');
        mocks.mkdir.mockRejectedValueOnce(permissionError);
        mocks.exists.mockResolvedValueOnce(false);

        await expect(withFileLock('/blocked/config.json', async () => undefined)).rejects.toBe(permissionError);
    });

    it('recovers an old ownerless lock instead of leaving it permanent', async () => {
        let acquiredOwner = '';
        mocks.mkdir
            .mockRejectedValueOnce(Object.assign(new Error('already exists'), { code: 'EEXIST' }))
            .mockResolvedValueOnce(undefined);
        mocks.readTextFile
            .mockRejectedValueOnce(new Error('owner missing'))
            .mockImplementation(async () => `${acquiredOwner}\n`);
        mocks.stat.mockResolvedValue({ mtime: new Date(Date.now() - 120_001) });
        mocks.writeTextFile.mockImplementation(async (_path: string, content: string) => {
            acquiredOwner = content.trim();
        });

        await expect(withFileLock('/home/test/.myagents/config.json', async () => 'acquired')).resolves.toBe('acquired');
        expect(mocks.rename).toHaveBeenCalledWith(
            '/home/test/.myagents/config.json.lock',
            expect.stringContaining('/home/test/.myagents/config.json.lock.stale-renderer-'),
        );
    });

    it('reports projects.json.lock as projects contention', async () => {
        const outcome = withProjectsLock(async () => undefined).catch((error) => error);

        await vi.advanceTimersByTimeAsync(5_100);
        expect(await outcome).toMatchObject({
            code: 'PROJECTS_BUSY',
            lockPath: '/home/test/.myagents/projects.json.lock',
        });
    });

    it('reports config.json.lock as config contention', async () => {
        const outcome = withConfigLock(async () => undefined).catch((error) => error);

        await vi.advanceTimersByTimeAsync(5_100);
        expect(await outcome).toMatchObject({
            code: 'CONFIG_BUSY',
            lockPath: '/home/test/.myagents/config.json.lock',
        });
    });

    it('reports agent-config-intent.lock as intent contention', async () => {
        const outcome = withAgentConfigIntentLock(async () => undefined).catch((error) => error);

        await vi.advanceTimersByTimeAsync(5_100);
        expect(await outcome).toMatchObject({
            code: 'AGENT_CONFIG_INTENT_BUSY',
            lockPath: '/home/test/.myagents/agent-config-intent.lock',
        });
    });

    it('does not let an outer intent lock rename an inner projects error', async () => {
        mocks.mkdir.mockResolvedValueOnce(undefined);

        const outcome = withAgentConfigIntentLock(async () => {
            throw new ProjectsBusyError('/home/test/.myagents/projects.json.lock', 5_000);
        }).catch((error) => error);

        expect(await outcome).toMatchObject({
            code: 'PROJECTS_BUSY',
            lockPath: '/home/test/.myagents/projects.json.lock',
        });
    });

    it('keeps a malformed renderer owner until the conservative threshold', async () => {
        mocks.readTextFile.mockResolvedValue('renderer:malformed\n');
        mocks.stat.mockResolvedValue({ mtime: new Date(Date.now() - 30_001) });

        const outcome = withFileLock('/home/test/.myagents/config.json', async () => undefined).catch((error) => error);

        await vi.advanceTimersByTimeAsync(5_100);
        expect(await outcome).toMatchObject({ code: 'FILE_BUSY' });
        expect(mocks.rename).not.toHaveBeenCalled();
    });
});
