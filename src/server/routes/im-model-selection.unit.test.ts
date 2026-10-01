import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMetadata } from '../types/session';
import { createConcreteProviderRoute } from '../../shared/providerRoute';
import { createRuntimeBackedProviderIdentity } from '../../shared/providerExecution';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(), loadProjects: vi.fn(), agent: vi.fn(), providers: vi.fn(), env: vi.fn(),
  availability: vi.fn(), resolve: vi.fn(), ready: vi.fn(), models: vi.fn(), get: vi.fn(), update: vi.fn(),
  context: vi.fn(), apply: vi.fn(), commit: vi.fn(), broadcast: vi.fn(),
}));
vi.mock('../utils/admin-config', () => ({ loadConfig: mocks.loadConfig, loadProjects: mocks.loadProjects,
  findProjectAgentByWorkspacePath: mocks.agent, getAllEffectiveProviders: mocks.providers,
  resolveProviderEnv: mocks.env, getProviderSelectionError: mocks.availability, resolveWorkspaceConfig: mocks.resolve }));
vi.mock('../utils/managed-codex-readiness', () => ({ isManagedCodexProviderReady: mocks.ready }));
vi.mock('../runtimes/external-session', () => ({ queryRuntimeModels: mocks.models }));
vi.mock('../SessionStore', () => ({ getSessionMetadata: mocks.get, updateSessionMetadata: mocks.update }));
vi.mock('../session-engine', () => ({ getSessionEngine: () => ({ getCurrentSessionContext: mocks.context, applyModelSelection: mocks.apply }) }));
vi.mock('../admin-api', () => ({ commitAgentModelSelection: mocks.commit }));
vi.mock('../sse', () => ({ broadcast: mocks.broadcast }));
import { handleImModelRoute, imSnapshotObservation } from './im-model-selection';

const env = { providerId: 'alpha', baseUrl: 'https://alpha.example/v1', apiProtocol: 'anthropic', apiKey: 'isolated-test-key' };
let metadata: SessionMetadata;
function selection(providerId = 'alpha', model = 'two') { return { kind: 'product-provider', providerId, model }; }
async function options(sessionId = 's') {
  const response = await handleImModelRoute('/api/im/model-options', new Request(`http://localhost/api/im/model-options?agentId=a&sessionId=${sessionId}`));
  return response!.json();
}
async function choose(chosen = selection(), observation = imSnapshotObservation(metadata), allowNewSession = true) {
  return handleImModelRoute('/api/im/model-selection', new Request('http://localhost/api/im/model-selection', { method: 'POST', body: JSON.stringify({ agentId: 'a', sessionId: 's', configSnapshotAt: metadata.configSnapshotAt, snapshotObservation: observation, selection: chosen, allowNewSession }) }));
}

beforeEach(() => {
  vi.resetAllMocks();
  metadata = { id: 's', agentDir: '/workspace/', title: '', createdAt: '', lastActiveAt: '',
    configSnapshotAt: '2026-10-01T00:00:00.000Z', runtime: 'builtin', providerId: 'alpha',
    model: 'one', permissionMode: 'plan', providerRoute: createConcreteProviderRoute('alpha', 'one'),
    providerEnvJson: JSON.stringify(env), reasoningEffort: 'high', mcpEnabledServers: ['mcp-a'], enabledPluginIds: ['plugin-a'] };
  mocks.loadConfig.mockReturnValue({ multiAgentRuntime: true });
  mocks.loadProjects.mockReturnValue([{ id: 'p', agentId: 'a', path: '/workspace' }]);
  mocks.agent.mockReturnValue({ id: 'a', name: 'Agent', enabled: true, permissionMode: 'plan', runtime: 'builtin', providerId: 'alpha', model: 'one' });
  mocks.providers.mockReturnValue([
    { id: 'alpha', name: 'Alpha', type: 'api', models: [{ model: 'one', modelName: 'One' }, { model: 'two', modelName: 'Two' }] },
    { id: 'beta', name: 'Beta', type: 'api', models: [{ model: 'two', modelName: 'Beta Two' }] },
    { id: 'codex-sub', name: 'Codex subscription', type: 'subscription', execution: { kind: 'runtime-backed', runtime: 'codex', source: 'managed-provider' }, models: [{ model: 'codex-live', modelName: 'Codex Live', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] },
  ]);
  mocks.env.mockImplementation((id: string) => ({ ...env, providerId: id, baseUrl: `https://${id}.example/v1` }));
  mocks.resolve.mockReturnValue({ providerEnv: env });
  mocks.ready.mockReturnValue(true);
  mocks.models.mockResolvedValue([{ value: 'codex-live', displayName: 'Codex Live', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }]);
  mocks.get.mockImplementation(() => metadata);
  mocks.context.mockReturnValue({ sessionId: 's' });
  mocks.update.mockImplementation(async (_id: string, patch: Partial<SessionMetadata>, predicate: (current: SessionMetadata) => boolean) => {
    if (!predicate(metadata)) return null;
    metadata = { ...metadata, ...patch };
    return metadata;
  });
  mocks.apply.mockResolvedValue({ success: true, status: 'applied' });
  mocks.commit.mockResolvedValue({ success: true, data: { reloadPatch: { model: 'two' } } });
});

describe('private IM Session model owner', () => {
  it('groups actual product options and mixes Managed Codex with incompatible marker', async () => {
    const menu = await options();
    expect(menu.options.map((option: { group: string }) => option.group)).toEqual(['Alpha', 'Alpha', 'Beta', 'Codex subscription']);
    expect(menu.options.at(-1)).toMatchObject({ selection: selection('codex-sub', 'codex-live'), requiresNewSession: true });
    expect(mocks.models).toHaveBeenCalledWith('codex', { runtimeSource: 'managed-provider' });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
  });
  it('uses native CLI models exclusively without product providers or Runtime switches', async () => {
    metadata.runtime = 'codex'; metadata.runtimeSource = 'system-cli';
    const menu = await options();
    expect(menu.options).toHaveLength(1);
    expect(menu.options[0]).toMatchObject({ selection: { kind: 'external-cli', runtime: 'codex', runtimeSource: 'system-cli', model: 'codex-live' }, requiresNewSession: false });
    expect(mocks.providers).not.toHaveBeenCalled();
  });
  it('marks the current provider/model without marking another provider with the same model id', async () => {
    metadata.model = 'two';
    const menu = await options();
    expect(menu.options.filter((option: { isCurrent: boolean }) => option.isCurrent)).toEqual([
      expect.objectContaining({ selection: selection('alpha', 'two') }),
    ]);
  });
  it('uses product model effort capabilities while preserving the rest of the Session', async () => {
    mocks.providers.mockReturnValue([{ id: 'alpha', name: 'Alpha', type: 'api', models: [
      { model: 'two', modelName: 'Two', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' },
    ] }]);
    const response = await choose();
    expect(await response!.json()).toMatchObject({ success: true });
    expect(metadata).toMatchObject({ reasoningEffort: 'default', permissionMode: 'plan', mcpEnabledServers: ['mcp-a'] });
  });
  it('keeps low permission, MCP and plugins while canonical routes materialize current credentials', async () => {
    const response = await choose();
    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({ success: true, sessionConfig: 'saved', agentDefault: 'saved' });
    expect(metadata).toMatchObject({ model: 'two', permissionMode: 'plan', providerEnvJson: undefined, mcpEnabledServers: ['mcp-a'], enabledPluginIds: ['plugin-a'] });
    expect(mocks.apply).toHaveBeenCalledWith({ model: 'two', providerEnv: env, reasoningEffort: 'high' });
    expect(mocks.commit).toHaveBeenCalledWith('a', selection(), 'high');
    expect(mocks.broadcast).toHaveBeenCalledWith('chat:session-config-changed', { sessionId: 's' });
  });
  it('plans a complete new-session birth without changing the source or defaults', async () => {
    const response = await choose(selection('codex-sub', 'codex-live'));
    expect(response!.status).toBe(409);
    expect(await response!.json()).toMatchObject({ requiresNewSession: true, birth: { agentDir: '/workspace', runtime: 'codex', runtimeSource: 'managed-provider', seedMaxPermission: true, model: 'codex-live' } });
    expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled();
  });
  it('projects a Managed-to-subscription birth through the desktop runtime policy', async () => {
    metadata.runtime = 'codex'; metadata.runtimeSource = 'managed-provider';
    metadata.providerId = 'codex-sub'; metadata.providerRoute = undefined;
    metadata.providerExecutionIdentity = createRuntimeBackedProviderIdentity({ providerId: 'codex-sub', model: 'old' });
    mocks.agent.mockReturnValue({ id: 'a', name: 'Agent', enabled: true, runtime: 'builtin',
      providerId: 'codex-sub', model: 'old', runtimePreference: { family: 'integrated', id: 'dsh' } });
    mocks.providers.mockReturnValue([{ id: 'anthropic-sub', name: 'Claude', type: 'subscription', models: [{ model: 'claude-sonnet-4-6', modelName: 'Sonnet' }] }]);
    mocks.env.mockReturnValue(undefined);
    const response = await choose(selection('anthropic-sub', 'claude-sonnet-4-6'));
    expect(await response!.json()).toMatchObject({ requiresNewSession: true, birth: {
      runtime: 'builtin', providerId: 'anthropic-sub', model: 'claude-sonnet-4-6', seedMaxPermission: true,
    } });
  });
  it('rejects same-millisecond Session edits using execution observation', async () => {
    const observation = imSnapshotObservation(metadata);
    metadata.model = 'other';
    const response = await choose(selection(), observation);
    expect(response!.status).toBe(409); expect(mocks.update).not.toHaveBeenCalled();
  });
  it('uses the selected Product model when Agent defaults have since moved to a native CLI', async () => {
    metadata.runtime = 'codex'; metadata.runtimeSource = 'managed-provider'; metadata.providerId = 'codex-sub';
    metadata.providerRoute = undefined;
    metadata.providerExecutionIdentity = createRuntimeBackedProviderIdentity({ providerId: 'codex-sub', model: 'old' });
    mocks.agent.mockReturnValue({ id: 'a', name: 'Agent', enabled: true, runtime: 'codex',
      runtimePreference: { family: 'external', id: 'codex' }, runtimeConfig: { source: 'system-cli', model: 'native-default' } });
    expect(await (await choose(selection()))!.json()).toMatchObject({ requiresNewSession: true,
      birth: { runtime: 'builtin', providerId: 'alpha', model: 'two', seedMaxPermission: true } });
  });
  it('refuses an unannounced incompatible transition without creating or editing a Session', async () => {
    const response = await choose(selection('codex-sub', 'codex-live'), imSnapshotObservation(metadata), false);
    expect(response!.status).toBe(409);
    expect(await response!.json()).toMatchObject({ success: false, error: '模型兼容性已变化，请重新发送 /model 查看列表' });
    expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled();
  });
  it('does not reject transcript/activity-only changes or JSON property order', () => {
    const observation = imSnapshotObservation(metadata);
    metadata.lastActiveAt = 'later'; metadata.title = 'new title';
    metadata.providerRoute = { model: 'one', providerId: 'alpha', kind: 'provider' };
    expect(imSnapshotObservation(metadata)).toBe(observation);
    expect(observation).not.toContain('isolated-test-key');
  });
  it('rechecks observation in the metadata writer lock', async () => {
    mocks.update.mockImplementation(async (_id, _patch, predicate) => predicate({ ...metadata, permissionMode: 'auto' }) ? metadata : null);
    const response = await choose();
    expect(response!.status).toBe(409); expect(mocks.apply).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled();
  });
  it('rejects a stale Session binding and removed/unavailable model', async () => {
    mocks.context.mockReturnValue({ sessionId: 'other' });
    expect((await choose())!.status).toBe(409);
    mocks.context.mockReturnValue({ sessionId: 's' });
    mocks.availability.mockReturnValue('missing credentials');
    expect((await choose())!.status).toBe(409); expect(mocks.update).not.toHaveBeenCalled();
  });
  it('reports partial Runtime failure after the snapshot commit without writing defaults', async () => {
    mocks.apply.mockRejectedValue(new Error('Runtime gone'));
    const response = await choose();
    expect(await response!.json()).toMatchObject({ success: false, sessionConfig: 'saved', runtimeApply: 'failed' });
    expect(metadata.model).toBe('two'); expect(mocks.commit).not.toHaveBeenCalled();
  });
  it('reports separate default-write failure and a busy Runtime pending next turn', async () => {
    mocks.apply.mockResolvedValue({ success: true, status: 'pending-next-turn' });
    mocks.commit.mockResolvedValue({ success: false, error: 'default disk failure' });
    expect(await (await choose())!.json()).toMatchObject({ success: false, sessionConfig: 'saved', runtimeApply: 'pending-next-turn', agentDefault: 'failed' });
    expect(metadata.model).toBe('two');
  });
  it('resets unsupported Managed Codex effort from the real catalog', async () => {
    metadata.runtime = 'codex'; metadata.runtimeSource = 'managed-provider'; metadata.providerId = 'codex-sub'; metadata.model = 'old'; metadata.providerRoute = undefined;
    metadata.providerExecutionIdentity = createRuntimeBackedProviderIdentity({ providerId: 'codex-sub', model: 'old' });
    await choose(selection('codex-sub', 'codex-live'));
    expect(metadata.reasoningEffort).toBe('default');
    expect(mocks.commit).toHaveBeenCalledWith('a', selection('codex-sub', 'codex-live'), 'default');
  });
  it('refuses unproven legacy metadata without promoting it from current defaults', async () => {
    metadata.configSnapshotAt = undefined;
    expect((await choose())!.status).toBe(409); expect(mocks.update).not.toHaveBeenCalled();
  });
});
