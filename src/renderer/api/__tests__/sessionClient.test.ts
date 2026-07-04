import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    apiFetch: vi.fn(),
    apiGetJson: vi.fn(),
    apiPostJson: vi.fn(),
    deactivateSession: vi.fn(),
    hasSessionSidecarOrThrow: vi.fn(),
    invoke: vi.fn(),
    isTauri: vi.fn(),
}));

vi.mock('../apiFetch', () => ({
    apiFetch: mocks.apiFetch,
    apiGetJson: mocks.apiGetJson,
    apiPostJson: mocks.apiPostJson,
}));

vi.mock('../tauriClient', () => ({
    deactivateSession: mocks.deactivateSession,
    hasSessionSidecarOrThrow: mocks.hasSessionSidecarOrThrow,
    isTauri: mocks.isTauri,
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: mocks.invoke,
}));

import { deleteSession, getSessions } from '../sessionClient';

const okResponse = () => new Response(JSON.stringify({ success: true }), { status: 200 });
const notFoundResponse = () => new Response(JSON.stringify({ success: false }), { status: 404 });

describe('deleteSession', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isTauri.mockReturnValue(true);
        mocks.hasSessionSidecarOrThrow.mockResolvedValue(false);
        mocks.deactivateSession.mockResolvedValue(undefined);
        mocks.apiFetch.mockResolvedValue(okResponse());
    });

    it('deletes storage only after confirming the session has no live sidecar', async () => {
        await expect(deleteSession('session-1')).resolves.toBe(true);

        expect(mocks.hasSessionSidecarOrThrow).toHaveBeenCalledWith('session-1');
        expect(mocks.apiFetch).toHaveBeenCalledWith('/sessions/session-1', { method: 'DELETE' });
        expect(mocks.deactivateSession).toHaveBeenCalledWith('session-1');
        expect(mocks.hasSessionSidecarOrThrow.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.apiFetch.mock.invocationCallOrder[0],
        );
    });

    it('refuses to delete storage while any sidecar owner is still alive', async () => {
        mocks.hasSessionSidecarOrThrow.mockResolvedValue(true);

        await expect(deleteSession('session-live')).resolves.toBe(false);

        expect(mocks.apiFetch).not.toHaveBeenCalled();
        expect(mocks.deactivateSession).not.toHaveBeenCalled();
    });

    it('does not release any owner as a side effect of storage deletion', async () => {
        mocks.hasSessionSidecarOrThrow.mockResolvedValue(true);

        await expect(deleteSession('session-owned')).resolves.toBe(false);

        expect(mocks.apiFetch).not.toHaveBeenCalled();
    });

    it('keeps browser development mode deletion working without Rust sidecar checks', async () => {
        mocks.isTauri.mockReturnValue(false);
        mocks.hasSessionSidecarOrThrow.mockResolvedValue(true);

        await expect(deleteSession('session-browser')).resolves.toBe(true);

        expect(mocks.hasSessionSidecarOrThrow).not.toHaveBeenCalled();
        expect(mocks.apiFetch).toHaveBeenCalledWith('/sessions/session-browser', { method: 'DELETE' });
    });

    it('fails closed when sidecar presence cannot be verified', async () => {
        mocks.hasSessionSidecarOrThrow.mockRejectedValue(new Error('ipc unavailable'));

        await expect(deleteSession('session-unknown')).resolves.toBe(false);

        expect(mocks.apiFetch).not.toHaveBeenCalled();
        expect(mocks.deactivateSession).not.toHaveBeenCalled();
    });

    it('returns false when the delete endpoint rejects the deletion', async () => {
        mocks.apiFetch.mockResolvedValue(notFoundResponse());

        await expect(deleteSession('missing-session')).resolves.toBe(false);

        expect(mocks.deactivateSession).not.toHaveBeenCalled();
    });
});

describe('getSessions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isTauri.mockReturnValue(true);
        mocks.invoke.mockResolvedValue([
            { id: 'session-older', lastActiveAt: '2026-07-03T00:00:00.000Z' },
            { id: 'session-tauri', lastActiveAt: '2026-07-04T00:00:00.000Z' },
        ]);
        mocks.apiGetJson.mockResolvedValue({
            success: true,
            sessions: [
                { id: 'session-http-old', lastActiveAt: '2026-07-02T00:00:00.000Z' },
                { id: 'session-http', lastActiveAt: '2026-07-04T00:00:00.000Z' },
            ],
        });
    });

    it('uses the Tauri metadata fast path in desktop mode', async () => {
        await expect(getSessions()).resolves.toEqual([
            { id: 'session-tauri', lastActiveAt: '2026-07-04T00:00:00.000Z' },
            { id: 'session-older', lastActiveAt: '2026-07-03T00:00:00.000Z' },
        ]);

        expect(mocks.invoke).toHaveBeenCalledWith('cmd_list_session_metadata', { agentDir: null });
        expect(mocks.apiGetJson).not.toHaveBeenCalled();
    });

    it('passes the optional workspace filter to the fast path', async () => {
        await getSessions('C:\\Users\\me\\workspace');

        expect(mocks.invoke).toHaveBeenCalledWith('cmd_list_session_metadata', {
            agentDir: 'C:\\Users\\me\\workspace',
        });
    });

    it('falls back to the HTTP sessions endpoint when the fast path fails', async () => {
        mocks.invoke.mockRejectedValue(new Error('ipc unavailable'));

        await expect(getSessions('/workspace/a')).resolves.toEqual([
            { id: 'session-http', lastActiveAt: '2026-07-04T00:00:00.000Z' },
            { id: 'session-http-old', lastActiveAt: '2026-07-02T00:00:00.000Z' },
        ]);

        expect(mocks.apiGetJson).toHaveBeenCalledWith('/sessions?agentDir=%2Fworkspace%2Fa');
    });

    it('keeps browser development mode on the HTTP sessions endpoint', async () => {
        mocks.isTauri.mockReturnValue(false);

        await expect(getSessions()).resolves.toEqual([
            { id: 'session-http', lastActiveAt: '2026-07-04T00:00:00.000Z' },
            { id: 'session-http-old', lastActiveAt: '2026-07-02T00:00:00.000Z' },
        ]);

        expect(mocks.invoke).not.toHaveBeenCalled();
        expect(mocks.apiGetJson).toHaveBeenCalledWith('/sessions');
    });
});
