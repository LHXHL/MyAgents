import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMetadata } from '../types/session';
const mocks = vi.hoisted(() => ({ context: vi.fn(), update: vi.fn(), mcp: vi.fn(), plugins: vi.fn(), official: vi.fn(), broadcast: vi.fn(), snapshot: vi.fn(), template: vi.fn(), birth: vi.fn(), effort: vi.fn() }));
vi.mock('./im-model-selection', () => ({ modelContext: mocks.context, agentContext: () => ({ config: {}, agent: { id: 'a' }, workspacePath: '/workspace' }), sessionEffortChoices: () => ['low', 'high'], imSnapshotObservation: (m: SessionMetadata) => m.configSnapshotAt,
  sameSelection: (a: { model: string }, b: { model: string }) => a.model === b.model, birthForSelection: mocks.birth }));
vi.mock('../session-engine', () => ({ getSessionEngine: () => ({ getCurrentSessionContext: () => ({ sessionId: 'current' }), isBusy: () => false, updateMcpServers: mocks.mcp, updateEnabledPluginIds: mocks.plugins, updateOfficialToolIds: mocks.official, updateReasoningEffort: mocks.effort }) }));
vi.mock('../SessionStore', () => ({ updateSessionMetadata: mocks.update, getSessionMetadata: () => undefined }));
vi.mock('../sse', () => ({ broadcast: mocks.broadcast }));
vi.mock('../plugins/store', () => ({ listInstalledPlugins: () => [{ id: 'plugin-a', name: 'Installed plugin' }] }));
vi.mock('../utils/admin-config', () => ({ getAllEffectiveProviders: () => [{ id: 'p', models: [{ model: 'a' }] }], getEnabledMcpServerIds: () => ['mcp-a'], getAllMcpServers: () => [{ id: 'mcp-a', name: 'MCP A', env: { PRIVATE_TOKEN: 'secret' } }], resolveWorkspaceConfig: () => ({ mcpServers: [{ name: 'MCP A' }] }) }));
vi.mock('../utils/session-snapshot', () => ({ snapshotForImRuntimeSwitch: mocks.snapshot, snapshotForImSession: mocks.template }));
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


const optionA = { selection: { kind: 'product-provider', providerId: 'p', model: 'a' }, group: 'P', name: 'A', isCurrent: true, requiresNewSession: false };
const optionB = { selection: { kind: 'product-provider', providerId: 'q', model: 'b' }, group: 'Q', name: 'B', isCurrent: false, requiresNewSession: false };
const peerConfig = (path: string, body: object) => handleTeamSessionConfigRoute(path, new Request('http://localhost' + path, { method: 'POST', body: JSON.stringify({ agentId: 'a', sessionId: 'current', profile: null, ...body }) }));
describe('Team AI peer config', () => {
  beforeEach(() => {
    mocks.template.mockReturnValue({ runtime: 'builtin', providerId: 'p', model: 'a', reasoningEffort: 'default', mcpEnabledServers: ['mcp-a'], enabledPluginIds: [], enabledOfficialToolIds: [] });
    // Agent-level, peer-config and Session contexts; the current Session can switch to A but needs a new Session for B.
    mocks.context.mockImplementation(async (_agent: string, sessionId?: string, base?: object) => sessionId
      ? { metadata, config: {}, agent: { id: 'a' }, workspacePath: '/workspace', options: [optionA, { ...optionB, requiresNewSession: true }] }
      : { metadata: null, current: base, config: {}, agent: { id: 'a' }, workspacePath: '/workspace', options: [optionA, optionB] });
  });

  it('shows the Agent template as the config and which models also apply to the current Session', async () => {
    const body = await (await peerConfig('/api/im/peer-config', {}))!.json();
    expect(body).toMatchObject({ success: true, custom: false, config: { runtime: 'builtin', model: 'a' } });
    expect(body.models.map((m: { appliesNow: boolean }) => m.appliesNow)).toEqual([true, false]);
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('composes the whole next config and the Session-only request for a compatible model', async () => {
    mocks.birth.mockReturnValue({ runtime: 'builtin', providerId: 'p', model: 'a' });
    const body = await (await peerConfig('/api/im/peer-config/compose', { change: { selection: optionA.selection } }))!.json();
    expect(body.profile).toMatchObject({ runtime: 'builtin', providerId: 'p', model: 'a', mcpEnabledServers: ['mcp-a'] });
    expect(body.apply).toEqual({ path: '/api/im/session-model-selection', body: { agentId: 'a', sessionId: 'current', snapshotObservation: 'observed', selection: optionA.selection, allowNewSession: false } });
  });

  it('changes only the config when the current Session cannot take the change', async () => {
    mocks.birth.mockReturnValue({ runtime: 'builtin', providerId: 'q', model: 'b' });
    const model = await (await peerConfig('/api/im/peer-config/compose', { change: { selection: optionB.selection } }))!.json();
    expect(model).toMatchObject({ profile: { providerId: 'q', model: 'b' }, apply: null });
    mocks.snapshot.mockReturnValue({ runtime: 'dsh', runtimeSource: 'integrated', providerId: 'p', model: 'a', mcpEnabledServers: ['mcp-a'] });
    const runtime = await (await peerConfig('/api/im/peer-config/compose', { change: { runtime: 'dsh' } }))!.json();
    expect(runtime).toMatchObject({ profile: { runtime: 'dsh', runtimeSource: 'integrated' }, apply: null, inEffect: false });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('says when the current Session already runs a config it was not asked to change', async () => {
    metadata = { ...metadata, providerId: 'p', model: 'a' };
    mocks.snapshot.mockReturnValue({ runtime: 'builtin', providerId: 'p', model: 'a' });
    const back = await (await peerConfig('/api/im/peer-config/compose', { profile: { runtime: 'dsh', runtimeSource: 'integrated', providerId: 'p', model: 'a' }, change: { runtime: 'builtin' } }))!.json();
    expect(back).toMatchObject({ profile: { runtime: 'builtin', model: 'a' }, apply: null, inEffect: true });
  });

  it('applies compatible effort and tool changes to the current Session, and nothing across Runtimes', async () => {
    const effort = await (await peerConfig('/api/im/peer-config/compose', { change: { effort: 'high' } }))!.json();
    expect(effort).toMatchObject({ profile: { reasoningEffort: 'high' }, apply: { path: '/api/im/session-effort', body: { sessionId: 'current', effort: 'high' } } });
    const tools = await (await peerConfig('/api/im/peer-config/compose', { change: { tools: { mcpEnabledServers: [], enabledPluginIds: ['plugin-a'], enabledOfficialToolIds: [] } } }))!.json();
    expect(tools).toMatchObject({ profile: { mcpEnabledServers: [], enabledPluginIds: ['plugin-a'] }, apply: { path: '/api/im/session-tools', body: { enabledPluginIds: ['plugin-a'] } } });
    metadata = { ...metadata, runtime: 'dsh', runtimeSource: 'integrated' };
    const elsewhere = await (await peerConfig('/api/im/peer-config/compose', { change: { effort: 'high' } }))!.json();
    expect(elsewhere).toMatchObject({ profile: { reasoningEffort: 'high' }, apply: null });
  });

  it('keeps the config viewable when its current Session is unusable or the Agent template cannot compile', async () => {
    mocks.context.mockImplementation(async (_agent: string, sessionId?: string, base?: object) => {
      if (sessionId) throw new Error('Session workspace does not match Agent');
      return { metadata: null, current: base, config: {}, agent: { id: 'a' }, workspacePath: '/workspace', options: [optionA] };
    });
    mocks.template.mockImplementation(() => { throw new Error('Managed Codex is not ready for IM Session birth'); });
    const body = await (await peerConfig('/api/im/peer-config', { profile: { runtime: 'builtin', providerId: 'p', model: 'a' } }))!.json();
    expect(body).toMatchObject({ success: true, custom: true, config: { providerId: 'p', model: 'a' } });
    expect(body.models[0].appliesNow).toBe(false);
  });

  it('rejects unavailable choices before composing anything', async () => {
    expect((await peerConfig('/api/im/peer-config/compose', { change: { effort: 'future-tier' } }))!.status).toBe(409);
    expect((await peerConfig('/api/im/peer-config/compose', { change: { tools: { mcpEnabledServers: ['missing'] } } }))!.status).toBe(409);
    expect((await peerConfig('/api/im/peer-config/compose', { change: { runtime: 'unknown' } }))!.status).toBe(400);
  });

  it('is served by Global, which still refuses Session writes', async () => {
    const serve = composeSidecarRequestHandler(resolveSidecarComposition('global', false), async request => (await handleTeamSessionConfigRoute(new URL(request.url).pathname, request)) ?? new Response('', { status: 404 }));
    const post = (path: string, body: object) => serve(new Request('http://localhost' + path, { method: 'POST', body: JSON.stringify(body) }));
    expect((await post('/api/im/peer-config', { agentId: 'a', profile: null })).status).toBe(200);
    expect((await post('/api/im/peer-config/compose', { agentId: 'a', profile: null, change: { effort: 'high' } })).status).toBe(200);
    for (const path of ['/api/im/session-tools', '/api/im/session-effort', '/api/im/session-model-selection']) expect((await post(path, {})).status).toBe(404);
  });
});

describe('Session-only effort', () => {
  it('persists effort only to the current Session and rejects unsupported values', async () => {
    const request = (effort: string) => handleTeamSessionConfigRoute('/api/im/session-effort', new Request('http://localhost/api/im/session-effort', {method:'POST',body:JSON.stringify({agentId:'a',sessionId:'current',snapshotObservation:'observed',effort})}));
    expect((await request('future-tier'))!.status).toBe(409);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(await (await request('high'))!.json()).toMatchObject({ success:true, sessionConfig:'saved' });
    expect(mocks.update.mock.calls[0][1]).toMatchObject({ reasoningEffort:'high' });
    expect(mocks.effort).toHaveBeenCalledWith('high');
  });
});
