import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMetadata } from '../types/session';
const mocks = vi.hoisted(() => ({ context: vi.fn(), update: vi.fn(), mcp: vi.fn(), plugins: vi.fn(), official: vi.fn(), broadcast: vi.fn(), snapshot: vi.fn(), effort: vi.fn() }));
vi.mock('./im-model-selection', () => ({ modelContext: mocks.context, sessionEffortChoices: () => ['low', 'high'], imSnapshotObservation: (m: SessionMetadata) => m.configSnapshotAt }));
vi.mock('../session-engine', () => ({ getSessionEngine: () => ({ getCurrentSessionContext: () => ({ sessionId: 'current' }), isBusy: () => false, updateMcpServers: mocks.mcp, updateEnabledPluginIds: mocks.plugins, updateOfficialToolIds: mocks.official, updateReasoningEffort: mocks.effort }) }));
vi.mock('../SessionStore', () => ({ updateSessionMetadata: mocks.update }));
vi.mock('../sse', () => ({ broadcast: mocks.broadcast }));
vi.mock('../plugins/store', () => ({ listInstalledPlugins: () => [{ id: 'plugin-a', name: 'Installed plugin' }] }));
vi.mock('../utils/admin-config', () => ({ getEnabledMcpServerIds: () => ['mcp-a'], getAllMcpServers: () => [{ id: 'mcp-a', name: 'MCP A', env: { PRIVATE_TOKEN: 'secret' } }], resolveWorkspaceConfig: () => ({ mcpServers: [{ name: 'MCP A' }] }) }));
vi.mock('../utils/session-snapshot', () => ({ snapshotForImRuntimeSwitch: mocks.snapshot }));
vi.mock('../utils/managed-codex-readiness', () => ({ isManagedCodexProviderReady: () => true }));
import { composeSidecarRequestHandler, resolveSidecarComposition } from '../sidecar-composition';
import { handleTeamSessionConfigRoute } from './team-session-config';
let metadata: SessionMetadata;
const call = (extra: object) => handleTeamSessionConfigRoute('/api/im/session-tools', new Request('http://localhost/api/im/session-tools', { method: 'POST', body: JSON.stringify({ agentId: 'a', sessionId: 'current', snapshotObservation: 'observed', ...extra }) }));
beforeEach(() => {
  vi.resetAllMocks();
  metadata = { id: 'current', agentDir: '/workspace', title: '', createdAt: '', lastActiveAt: '', configSnapshotAt: 'observed', permissionMode: 'plan', runtime: 'builtin', mcpEnabledServers: [] };
  mocks.context.mockResolvedValue({ metadata, config: {}, agent: { id: 'a' }, workspacePath: '/workspace' });
  mocks.update.mockImplementation(async (_id, updates, condition) => condition(metadata) ? ({ ...metadata, ...updates }) : null);
  for (const apply of [mocks.mcp, mocks.plugins, mocks.official, mocks.effort]) apply.mockResolvedValue({ success: true });
});
describe('Session-only tool management', () => {
  it('returns a credential-free catalogue without applying configuration', async () => {
    const response = await handleTeamSessionConfigRoute('/api/im/session-tools', new Request('http://localhost/api/im/session-tools?agentId=a&sessionId=current'));
    const body = await response!.json();
    expect(body.mcp).toEqual([{ id: 'mcp-a', name: 'MCP A' }]);
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('saves only tool fields and applies through the active Session facade', async () => {
    const response = await call({ mcpEnabledServers: ['mcp-a'], enabledPluginIds: ['plugin-a'], permissionMode: 'bypassPermissions' });
    expect(await response!.json()).toMatchObject({ success: true, sessionConfig: 'saved' });
    expect(mocks.update.mock.calls[0][1]).toMatchObject({ mcpEnabledServers: ['mcp-a'], enabledPluginIds: ['plugin-a'] });
    expect(mocks.update.mock.calls[0][1]).not.toHaveProperty('permissionMode');
    expect(mocks.mcp).toHaveBeenCalledWith([{ name: 'MCP A' }]);
    expect(mocks.plugins).toHaveBeenCalledWith(['plugin-a']);
  });
  it('rejects stale menus and unknown tool IDs before persisting', async () => {
    expect((await call({ snapshotObservation: 'old', mcpEnabledServers: [] }))!.status).toBe(409);
    expect((await call({ mcpEnabledServers: ['missing'] }))!.status).toBe(409);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('reports a saved snapshot when runtime apply fails', async () => {
    mocks.mcp.mockResolvedValue({ success: false, error: 'runtime unavailable' });
    expect(await (await call({ mcpEnabledServers: [] }))!.json()).toMatchObject({ success: false, sessionConfig: 'saved', runtimeApply: 'failed' });
  });
});


describe('Team management production composition', () => {
  it('Global serves the real tool catalogue and runtime plan but refuses Session writes', async () => {
    mocks.snapshot.mockReturnValue({ runtime: 'dsh', providerId: 'session-provider', model: 'session-model' });
    const serve = composeSidecarRequestHandler(resolveSidecarComposition('global', false), async request => (await handleTeamSessionConfigRoute(new URL(request.url).pathname, request)) ?? new Response('', { status: 404 }));
    expect((await serve(new Request('http://localhost/api/im/session-tools?agentId=a&sessionId=current'))).status).toBe(200);
    const plan = await serve(new Request('http://localhost/api/im/session-runtime', { method: 'POST', body: JSON.stringify({agentId:'a',sessionId:'current',snapshotObservation:'observed',runtime:'dsh'}) }));
    expect(await plan.json()).toMatchObject({ birth: { runtime: 'dsh', runtimeSwitchSourceSessionId: 'current', runtimeSwitchObservation: 'observed' } });
    expect(mocks.snapshot).toHaveBeenCalledWith(metadata, 'dsh');
    for (const path of ['/api/im/session-tools', '/api/im/session-effort', '/api/im/session-model-selection']) expect((await serve(new Request('http://localhost'+path, {method:'POST', body:'{}'}))).status).toBe(404);
  });
  it('persists effort only to the current Session and rejects unsupported values', async () => {
    const request = (effort: string) => handleTeamSessionConfigRoute('/api/im/session-effort', new Request('http://localhost/api/im/session-effort', {method:'POST',body:JSON.stringify({agentId:'a',sessionId:'current',snapshotObservation:'observed',effort})}));
    expect((await request('future-tier'))!.status).toBe(409);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(await (await request('high'))!.json()).toMatchObject({ success:true, sessionConfig:'saved' });
    expect(mocks.update.mock.calls[0][1]).toMatchObject({ reasoningEffort:'high' });
    expect(mocks.effort).toHaveBeenCalledWith('high');
  });
});
