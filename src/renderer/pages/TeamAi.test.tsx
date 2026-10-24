import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/config/types';
import type { SessionMetadata } from '@/api/sessionClient';
import type { TeamChannel, TeamModelMenu, TeamPeer, TeamTools } from '@/../shared/teamAi';
import { i18n } from '@/i18n';
const mocks = vi.hoisted(() => ({ projects: [] as Project[], patch: vi.fn(), channels: vi.fn(), sessions: vi.fn(), action: vi.fn(), states: vi.fn(), enable: vi.fn(), translate: vi.fn<(key: string, options?: Record<string, unknown>) => string | undefined>() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => mocks.translate(key, options) ?? key }) }));
vi.mock('@/config/useConfigData', () => ({ useConfigData: () => ({ projects: mocks.projects, config: {} }) }));
vi.mock('@/config/useConfigActions', () => ({ useConfigActions: () => ({ patchProject: mocks.patch }) }));
vi.mock('@/config/services/agentConfigService', () => ({ startAndEnableAgentChannel: mocks.enable }));
vi.mock('@/utils/tauriListen', () => ({ listenWithCleanup: vi.fn(async () => ({})) }));
vi.mock('@/api/sessionClient', () => ({ getSessions: mocks.sessions }));
vi.mock('@/features/team-ai/client', () => ({ teamChannels: mocks.channels, teamAction: mocks.action, teamStates: mocks.states }));
import TeamAi from './TeamAi';

const project: Project = { id: 'workspace', agentId: 'agent', name: 'Support department', path: '/workspace', purpose: 'team-ai', providerId: null, permissionMode: null };
const now = Date.now();
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const metadata: SessionMetadata = { id: 'session-a', agentDir: '/workspace', title: 'Budget analysis', createdAt: iso(90), lastActiveAt: iso(5), runtime: 'builtin', model: 'model-a', configSnapshotAt: 'observed', mcpEnabledServers: ['mcp-a'] };
const earlier: SessionMetadata = { ...metadata, id: 'session-b', title: 'Earlier analysis', lastActiveAt: iso(3000) };
const peer: TeamPeer = { sessionKey: 'agent:agent:feishu:group:room', sourceId: 'room', sourceType: 'group', name: 'Planning room', sessionId: 'session-a', sessionIds: ['session-a', 'session-b', 'session-gone'], lastActive: iso(5), hasProfile: false };
const privatePeer: TeamPeer = { sessionKey: 'agent:agent:feishu:private:u1', sourceId: 'u1', sourceType: 'private', name: 'Li', sessionId: null, sessionIds: [], lastActive: iso(60), hasProfile: false };
const channel: TeamChannel = { channelId: 'bot-a', platform: 'feishu', name: 'Department Bot', online: true, enabled: true, status: 'online', peers: [privatePeer, peer] };
const catalog: TeamModelMenu = {
  runtime: 'builtin', snapshotObservation: 'observed', reasoningEffortChoices: ['low', 'high'], options: [
    { group: 'Department provider', name: 'Current model', isCurrent: true, requiresNewSession: false, selection: { kind: 'product-provider', providerId: 'provider-a', model: 'model-a' } },
    { group: 'Department provider', name: 'Sibling model', isCurrent: false, requiresNewSession: false, selection: { kind: 'product-provider', providerId: 'provider-a', model: 'model-c' } },
    { group: 'Other provider', name: 'Other model', isCurrent: false, requiresNewSession: true, selection: { kind: 'product-provider', providerId: 'provider-b', model: 'model-b' } },
  ],
};
const tools: TeamTools = {
  canManageExtensions: true, snapshotObservation: 'tools-observed',
  mcp: [{ id: 'mcp-a', name: 'Department MCP' }], plugins: [{ id: 'plugin-a', name: 'Department plugin' }], official: [{ id: 'official-a', name: 'Official tool' }],
  mcpEnabledServers: ['mcp-a'], enabledPluginIds: [], enabledOfficialToolIds: [],
};
const props = () => ({ isActive: true, onCreate: vi.fn(), onSelectProject: vi.fn(), onOpenSession: vi.fn(), onOpenWorkspace: vi.fn() });
const selectPeer = async (name = 'Planning room') => fireEvent.click(await screen.findByRole('option', { name: new RegExp(name) }));
const row = (label: string) => screen.getByRole('group', { name: label });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.projects = [project];
  mocks.states.mockResolvedValue({ states: [] });
  mocks.channels.mockResolvedValue({ channels: [channel] });
  mocks.sessions.mockResolvedValue([metadata, earlier]);
  mocks.enable.mockResolvedValue(undefined);
  mocks.action.mockImplementation(async (_agent, _channel, _peer, action) => action.kind === 'options' ? catalog : action.kind === 'tools' ? tools : { success: true });
});

describe('Team AI list', () => {
  it('lists every peer flat, most recent first, with its kind and Bot', async () => {
    render(<TeamAi {...props()} />);
    const options = await screen.findAllByRole('option');
    expect(options.map(option => option.textContent)).toEqual([
      expect.stringContaining('Planning room'),
      expect.stringContaining('Li'),
    ]);
    expect(options[0]).toHaveTextContent('teamAi.group');
    expect(options[0]).toHaveTextContent('Department Bot');
    expect(screen.getByText('teamAi.selectPeer')).toBeInTheDocument();
  });

  it('marks only what needs attention and keeps disabled Bots browsable', async () => {
    mocks.channels.mockResolvedValue({ channels: [{ ...channel, enabled: false, online: false, status: 'stopped' }] });
    mocks.states.mockResolvedValue({ states: [{ channelId: 'bot-a', sessionKey: peer.sessionKey, sessionId: 'session-a', state: 'error' }] });
    render(<TeamAi {...props()} />);
    const planning = await screen.findByRole('option', { name: /Planning room/ });
    expect(within(planning).getByLabelText('teamAi.status.error')).toBeInTheDocument();
    expect(within(planning).getByText('teamAi.disabled')).toBeInTheDocument();
    fireEvent.click(planning);
    expect(await screen.findByText('teamAi.channelOff')).toBeInTheDocument();
    expect(within(row('teamAi.model')).getByRole('button')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'teamAi.new' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'teamAi.enable' }));
    await waitFor(() => expect(mocks.enable).toHaveBeenCalledWith('agent', 'bot-a'));
    expect(mocks.action).not.toHaveBeenCalled();
  });

  it('distinguishes a failed Channel read from a Bot without conversations', async () => {
    mocks.channels.mockResolvedValue({ channels: [{ ...channel, peers: [], loadError: 'State file unreadable' }, { ...channel, channelId: 'bot-b', name: 'Quiet Bot', peers: [] }] });
    render(<TeamAi {...props()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('teamAi.loadFailed');
    expect(screen.getByText('teamAi.botNoPeers')).toBeInTheDocument();
  });

  it('keeps same-platform Bots with identical peer keys separately targeted', async () => {
    mocks.channels.mockResolvedValue({ channels: [channel, { ...channel, channelId: 'bot-b', name: 'Second Bot', peers: [{ ...peer, lastActive: iso(1), sessionId: 'session-b', sessionIds: ['session-a', 'session-b'] }] }] });
    render(<TeamAi {...props()} />);
    fireEvent.click((await screen.findAllByRole('option', { name: /Planning room/ }))[0]);
    fireEvent.contextMenu(await screen.findByRole('button', { name: /Budget analysis/ }), { clientX: 40, clientY: 70 });
    fireEvent.click(await screen.findByText('teamAi.setCurrentMenu'));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith('agent', 'bot-b', expect.objectContaining({ sessionId: 'session-b' }), { kind: 'setPrimary', sessionId: 'session-a' }));
  });
});

describe('Team AI current Session', () => {
  it('shows status and settings, never the transcript, and opens Chat through the App binding', async () => {
    mocks.states.mockResolvedValue({ states: [{ channelId: 'bot-a', sessionKey: peer.sessionKey, sessionId: 'session-a', state: null }] });
    const open = props();
    render(<TeamAi {...open} />);
    await selectPeer();
    expect(await screen.findByText('teamAi.status.dormant')).toBeInTheDocument();
    expect(screen.getByText('teamAi.statusDesc.dormant')).toBeInTheDocument();
    await waitFor(() => expect(within(row('teamAi.model')).getByRole('button')).toHaveTextContent('Current model'));
    expect(screen.getByText('teamAi.profile.default')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'teamAi.open' }));
    expect(open.onOpenSession).toHaveBeenCalledWith(metadata, project);
  });

  it('shows a Session without an observation row as unknown, never as not running', async () => {
    render(<TeamAi {...props()} />);
    await selectPeer();
    expect(await screen.findByText('teamAi.status.unknown')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'teamAi.status.dormant' })).toBeNull();
  });

  it('shows a failed observation as unknown, never as not running', async () => {
    mocks.states.mockResolvedValue({ states: [{ channelId: 'bot-a', sessionKey: peer.sessionKey, sessionId: 'session-a', state: null, error: 'timeout' }] });
    render(<TeamAi {...props()} />);
    await selectPeer();
    expect(await screen.findByText('teamAi.status.unknown')).toBeInTheDocument();
    expect(screen.queryByText('teamAi.status.dormant')).toBeNull();
  });

  it('stops a running Session from its status strip', async () => {
    mocks.states.mockResolvedValue({ states: [{ channelId: 'bot-a', sessionKey: peer.sessionKey, sessionId: 'session-a', state: 'running' }] });
    render(<TeamAi {...props()} />);
    await selectPeer();
    fireEvent.click(await screen.findByRole('button', { name: 'teamAi.stop' }));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith('agent', 'bot-a', peer, { kind: 'stop' }));
  });

  it('applies a compatible model and says new Sessions follow when the peer profile was created', async () => {
    mocks.action.mockImplementation(async (_a, _c, _p, action) => action.kind === 'options' ? catalog : { success: true, sessionConfig: 'saved', peerProfile: 'saved' });
    render(<TeamAi {...props()} />);
    await selectPeer();
    await waitFor(() => expect(within(row('teamAi.model')).getByRole('button')).toBeEnabled());
    fireEvent.click(within(row('teamAi.model')).getByRole('button'));
    fireEvent.click(await screen.findByText('Sibling model'));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith('agent', 'bot-a', peer, { kind: 'selectModel', selection: catalog.options[1].selection, snapshotObservation: 'observed', confirmed: false }));
    expect(await screen.findByText('teamAi.done.modelteamAi.profile.followed')).toBeInTheDocument();
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it('confirms before a model that needs a new Session', async () => {
    render(<TeamAi {...props()} />);
    await selectPeer();
    await waitFor(() => expect(within(row('teamAi.model')).getByRole('button')).toBeEnabled());
    fireEvent.click(within(row('teamAi.model')).getByRole('button'));
    fireEvent.click(await screen.findByText('Other model'));
    expect(mocks.action.mock.calls.some(call => call[3].kind === 'selectModel')).toBe(false);
    fireEvent.click(await screen.findByRole('button', { name: 'teamAi.switchConfirm' }));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith('agent', 'bot-a', peer, { kind: 'selectModel', selection: catalog.options[2].selection, snapshotObservation: 'observed', confirmed: true }));
  });

  it('restores Agent defaults for a peer that owns its settings', async () => {
    mocks.channels.mockResolvedValue({ channels: [{ ...channel, peers: [{ ...peer, hasProfile: true }] }] });
    render(<TeamAi {...props()} />);
    await selectPeer();
    expect(await screen.findByText('teamAi.profile.custom')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'teamAi.profile.reset' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'teamAi.profile.reset' }));
    fireEvent.click(await screen.findByRole('button', { name: 'teamAi.profile.resetConfirm' }));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith('agent', 'bot-a', expect.objectContaining({ sessionKey: peer.sessionKey }), { kind: 'clearProfile' }));
  });

  it('saves each tool toggle immediately and keeps native CLI extensions read-only', async () => {
    render(<TeamAi {...props()} />);
    await selectPeer();
    fireEvent.click(within(row('teamAi.tools')).getByRole('button'));
    fireEvent.click(await screen.findByRole('switch', { name: 'Official tool' }));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith('agent', 'bot-a', peer, {
      kind: 'saveTools', snapshotObservation: 'tools-observed', mcpEnabledServers: ['mcp-a'], enabledPluginIds: [], enabledOfficialToolIds: ['official-a'],
    }));

    mocks.action.mockImplementation(async (_a, _c, _p, action) => action.kind === 'tools' ? { ...tools, canManageExtensions: false } : action.kind === 'options' ? catalog : { success: true });
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(within(row('teamAi.tools')).getByRole('button'));
    await waitFor(() => expect(screen.getAllByRole('switch', { name: 'Department MCP' }).at(-1)).toBeDisabled());
  });

  it('shows the same managed Runtime identity as Chat', async () => {
    mocks.sessions.mockResolvedValue([{ ...metadata, runtime: 'codex', runtimeSource: 'managed-provider' }, earlier]);
    render(<TeamAi {...props()} />);
    await selectPeer();
    expect(await within(row('teamAi.runtime')).findByText('Managed Codex')).toBeInTheDocument();
  });

  it.each([['zh-CN', '正在启动'], ['en-US', 'Starting']])('uses real %s translations for the live state', async (locale, label) => {
    await i18n.changeLanguage(locale);
    mocks.translate.mockImplementation((key, options) => String(i18n.t(key, { ...options, ns: 'app' })));
    mocks.states.mockResolvedValue({ states: [{ channelId: 'bot-a', sessionKey: peer.sessionKey, sessionId: 'session-a', state: 'starting' }] });
    render(<TeamAi {...props()} />);
    await selectPeer();
    expect(await screen.findByText(label)).toBeInTheDocument();
  });
});

describe('Team AI history', () => {
  it('shows one line per Session, opens it on click, and notes deleted ones', async () => {
    mocks.states.mockResolvedValue({ states: [{ channelId: 'bot-a', sessionKey: peer.sessionKey, sessionId: 'session-b', state: 'running' }] });
    const open = props();
    render(<TeamAi {...open} />);
    await selectPeer();
    const history = await screen.findByRole('button', { name: /Earlier analysis/ });
    expect(within(history).getByText('teamAi.finishing')).toBeInTheDocument();
    expect(screen.getByText('teamAi.deletedCount')).toBeInTheDocument();
    fireEvent.click(history);
    expect(open.onOpenSession).toHaveBeenCalledWith(earlier, project);
    expect(mocks.action.mock.calls.some(call => call[3].kind === 'setPrimary')).toBe(false);
  });

  it('sets a history Session as current only for the peer that owns it', async () => {
    render(<TeamAi {...props()} />);
    await selectPeer();
    const history = await screen.findByRole('button', { name: /Earlier analysis/ });
    fireEvent.click(within(history).getByRole('button', { name: 'teamAi.setCurrent' }));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith('agent', 'bot-a', peer, { kind: 'setPrimary', sessionId: 'session-b' }));
  });
});

describe('Team AI workspaces', () => {
  it('joins an existing workspace with a usage patch and preserves its identity', async () => {
    mocks.projects = [
      { ...project, displayName: 'Support department', purpose: undefined },
      { ...project, id: 'hidden', purpose: undefined, hidden: true },
      { ...project, id: 'archived', purpose: undefined, archivedAt: '2026-10-24T00:00:00Z' },
      { ...project, id: 'no-agent', purpose: undefined, agentId: undefined },
    ];
    const page = props();
    render(<TeamAi {...page} />);
    expect(screen.getByText('teamAi.onboarding.title')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'teamAi.join' }));
    const dialog = screen.getByRole('dialog', { name: 'teamAi.selectWorkspaceTitle' });
    expect(within(dialog).getAllByRole('button')).toHaveLength(2); // close + sole eligible workspace
    fireEvent.click(within(dialog).getByRole('button', { name: /Support department/ }));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('workspace', { purpose: 'team-ai' }));
    expect(page.onSelectProject).toHaveBeenCalledWith('workspace');
  });

  it('dismisses the workspace picker with Escape and restores focus without changing config', async () => {
    const user = userEvent.setup();
    mocks.projects = [{ ...project, purpose: undefined }];
    render(<TeamAi {...props()} />);
    const trigger = screen.getByRole('button', { name: 'teamAi.join' });
    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it('switches Team AI from the header and removes only the usage tag', async () => {
    mocks.projects = [project, { ...project, id: 'new-team', agentId: 'new-agent', path: '/new-team', name: 'New Team' }];
    const page = props();
    render(<TeamAi {...page} projectId="new-team" />);
    await waitFor(() => expect(mocks.channels).toHaveBeenCalledWith('new-agent'));
    const switcher = screen.getByRole('button', { name: 'teamAi.switchAgent' });
    expect(switcher).toHaveTextContent('New Team');
    fireEvent.click(switcher);
    fireEvent.click(await screen.findByRole('menuitem', { name: /Support department/ }));
    expect(page.onSelectProject).toHaveBeenCalledWith('workspace');
  });

  it('distinguishes a failed page read from an empty Channel list', async () => {
    mocks.channels.mockRejectedValue(new Error('Config unreadable'));
    render(<TeamAi {...props()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Config unreadable');
    expect(screen.queryByText('teamAi.noChannelTitle')).toBeNull();
  });

  it('offers to connect a chatbot when the Agent has none', async () => {
    mocks.channels.mockResolvedValue({ channels: [] });
    render(<TeamAi {...props()} />);
    expect(await screen.findByText('teamAi.noChannelTitle')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /teamAi.connectBot/ }).length).toBeGreaterThan(0);
  });
});
