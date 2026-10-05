import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CLI_SESSION_HEADER, cliSessionScopeError } from '../../shared/cli-session-scope';
import { LOG_SESSION_HEADER } from '../../shared/types/log';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/utils/browserMock', () => ({ isTauriEnvironment: () => true }));

async function loadClient() {
    vi.resetModules();
    return import('./tauriClient');
}

describe('tauriClient global sidecar readiness', () => {
    beforeEach(() => mocks.invoke.mockReset());

    it('probes Rust readiness without exposing or caching the physical URL', async () => {
        mocks.invoke.mockResolvedValue('http://127.0.0.1:31415');
        const { waitForGlobalSidecar } = await loadClient();

        await expect(waitForGlobalSidecar()).resolves.toBeUndefined();
        expect(mocks.invoke).toHaveBeenCalledWith('cmd_get_global_server_url');
    });

    it('polls Rust until the global sidecar becomes available', async () => {
        let attempts = 0;
        mocks.invoke.mockImplementation(async (cmd: string) => {
            if (cmd !== 'cmd_get_global_server_url') return undefined;
            attempts++;
            if (attempts < 3) throw new Error('No running sidecar for tab __global__');
            return 'http://127.0.0.1:31416';
        });
        const { waitForGlobalSidecar } = await loadClient();

        await expect(waitForGlobalSidecar()).resolves.toBeUndefined();
        expect(attempts).toBe(3);
    });

});

describe('tauriClient owner-addressed control dispatch', () => {
    beforeEach(() => mocks.invoke.mockReset());

    it('keeps active-chat log correlation out of global Admin execution identity', async () => {
        mocks.invoke.mockImplementation(async (_cmd, payload) => {
            if (!payload?.request) return undefined;
            const scopeError = cliSessionScopeError(new Headers(payload.request.headers).get(CLI_SESSION_HEADER), null);
            return { status: scopeError ? 409 : 200, body: JSON.stringify(scopeError ?? { success: true, data: { models: [] } }), headers: {}, is_base64: false };
        });
        const { globalSidecarFetch, setAppActiveCorrelation } = await loadClient();
        setAppActiveCorrelation({ tabId: 'chat', tabs: [{ id: 'chat', sessionId: 'active-chat' }] });
        const result = await globalSidecarFetch('/api/admin/vision/models', { method: 'POST', body: '{}' });
        expect(result.status).toBe(200);
        const headers = new Headers(mocks.invoke.mock.calls.find(([cmd]) => cmd === 'global_sidecar_http_request')![1].request.headers);
        expect(headers.get(CLI_SESSION_HEADER)).toBeNull();
        expect(headers.get(LOG_SESSION_HEADER)).toBe('active-chat');
    });

    it('keeps explicit target log correlation without treating another active chat as caller identity', async () => {
        mocks.invoke.mockImplementation(async (_cmd, payload) => {
            if (!payload?.request) return undefined;
            const scopeError = cliSessionScopeError(new Headers(payload.request.headers).get(CLI_SESSION_HEADER), 'target-session');
            return { status: scopeError ? 409 : 200, body: '{}', headers: {}, is_base64: false };
        });
        const { sessionSidecarFetch, setAppActiveCorrelation } = await loadClient();
        setAppActiveCorrelation({ tabId: 'other', tabs: [{ id: 'other', sessionId: 'other-session' }] });
        const result = await sessionSidecarFetch('target-session', { type: 'tab', id: 'target-tab' }, '/api/admin/status', { method: 'POST', headers: { [LOG_SESSION_HEADER]: 'target-session' } });
        expect(result.status).toBe(200);
        const headers = new Headers(mocks.invoke.mock.calls.find(([cmd]) => cmd === 'session_sidecar_http_request')![1].request.headers);
        expect(headers.get(LOG_SESSION_HEADER)).toBe('target-session');
        expect(headers.get(CLI_SESSION_HEADER)).toBeNull();
    });

    it('sends Session requests with logical owner and path, never a renderer-selected URL', async () => {
        mocks.invoke.mockResolvedValue({
            status: 200,
            body: '{}',
            headers: { 'content-type': 'application/json' },
            is_base64: false,
        });
        const {
            getActiveTabId,
            sessionSidecarFetch,
            setActiveCorrelation,
            setAppActiveCorrelation,
            setFocusedCorrelationTabId,
        } = await loadClient();

        setActiveCorrelation({ tabId: 'old-chat-tab', sessionId: 'old-session', mounted: true });
        setFocusedCorrelationTabId('old-chat-tab');
        setAppActiveCorrelation({
            tabId: 'new-launcher-tab',
            tabs: [
                { id: 'old-chat-tab', sessionId: 'old-session' },
                { id: 'new-launcher-tab', sessionId: null },
            ],
        });

        await sessionSidecarFetch('target-session', { type: 'tab', id: 'target-tab' }, '/api/test');

        expect(getActiveTabId()).toBe('new-launcher-tab');
        expect(mocks.invoke).toHaveBeenCalledWith('session_sidecar_http_request', {
            sessionIdHint: 'target-session',
            sidecarOwnerType: 'tab',
            sidecarOwnerId: 'target-tab',
            request: {
                path: '/api/test',
                method: 'GET',
                body: undefined,
                headers: { 'X-MyAgents-Tab-Id': 'new-launcher-tab' },
            },
        });
    });

    it('keeps explicit request headers on global owner-addressed requests', async () => {
        mocks.invoke.mockResolvedValue({
            status: 200,
            body: '{}',
            headers: { 'content-type': 'application/json' },
            is_base64: false,
        });
        const { globalSidecarFetch } = await loadClient();

        await globalSidecarFetch('/chat/send', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-MyAgents-Tab-Id': 'target-tab',
                'X-MyAgents-Session-Id': 'target-session',
            },
            body: '{}',
        });

        expect(mocks.invoke).toHaveBeenCalledWith('global_sidecar_http_request', {
            request: {
                path: '/chat/send',
                method: 'POST',
                body: '{}',
                headers: {
                    'Content-Type': 'application/json',
                    'X-MyAgents-Tab-Id': 'target-tab',
                    'X-MyAgents-Session-Id': 'target-session',
                },
            },
        });
    });
});
