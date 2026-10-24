import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/config/types';
import type { SessionMetadata } from '@/api/sessionClient';
const mocks = vi.hoisted(() => ({ projects: [] as Project[], patch: vi.fn(), channels: vi.fn(), sessions: vi.fn(), detail: vi.fn(), action: vi.fn(), states: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/config/useConfigData', () => ({ useConfigData: () => ({ projects: mocks.projects, config: {} }) }));
vi.mock('@/config/useConfigActions', () => ({ useConfigActions: () => ({ patchProject: mocks.patch }) }));
vi.mock('@/utils/tauriListen', () => ({ listenWithCleanup: vi.fn(async () => ({})) }));
vi.mock('@/api/sessionClient', () => ({ getSessions: mocks.sessions }));
vi.mock('@/features/team-ai/client', () => ({ teamChannels: mocks.channels, teamSession: mocks.detail, teamAction: mocks.action, teamStates: mocks.states }));
import TeamAi from './TeamAi';
import { ImagePreviewProvider } from '@/context/ImagePreviewContext';
const project: Project = { id: 'workspace', agentId: 'agent', name: 'Support department', path: '/workspace', purpose: 'team-ai', providerId: null, permissionMode: null };
const metadata: SessionMetadata = { id: 'session-a', agentDir: '/workspace', title: 'Budget analysis', createdAt: '', lastActiveAt: '', runtime: 'builtin', model: 'model-a', configSnapshotAt: 'observed' };
const peer = { sessionKey: 'agent:agent:feishu:group:room', sourceId: 'room', sourceType: 'group', name: 'Planning room', sessionId: 'session-a', sessionIds: ['session-a', 'session-b'], lastActive: null };
const channel = { channelId: 'bot-a', platform: 'feishu', name: 'Department Bot', online: true, enabled: true, status: 'online', peers: [peer] };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.projects = [project];
  mocks.states.mockResolvedValue({ states: [] });
  mocks.channels.mockResolvedValue({ channels: [channel] });
  mocks.sessions.mockResolvedValue([metadata, { ...metadata, id: 'session-b', title: 'Earlier analysis' }]);
  mocks.detail.mockResolvedValue({ session: { ...metadata, messages: [], liveSessionState: 'idle' } });
  mocks.action.mockImplementation(async (_agent, _channel, _peer, action) => action.kind === 'options' ? { runtime: 'builtin', snapshotObservation: 'observed', options: [] } : { success: true });
});
describe('Team AI channel management', () => {
  it('shows contextual history and rebinds only the peer that owns its menu', async () => {
    render(<TeamAi isActive onCreate={vi.fn()} onSelectProject={vi.fn()} onOpenSession={vi.fn()} />);
    const history = await screen.findByRole('button', { name: /Earlier analysis/ });
    fireEvent.contextMenu(history.parentElement!, { clientX: 40, clientY: 70 });
    fireEvent.click(await screen.findByText('teamAi.setPrimary'));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith('agent', 'bot-a', peer, { kind: 'setPrimary', sessionId: 'session-b' }));
  });
  it('opens the actual Session through the App binding', async () => {
    const open = vi.fn();
    render(<TeamAi isActive onCreate={vi.fn()} onSelectProject={vi.fn()} onOpenSession={open} />);
    fireEvent.click(await screen.findByRole('button', { name: /Budget analysis/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'teamAi.open' }));
    expect(open).toHaveBeenCalledWith(metadata, project);
    expect(mocks.detail).toHaveBeenCalledWith('agent', 'bot-a', peer.sessionKey, 'session-a');
  });
  it('keeps stopped conversations readable while disabling mutating actions', async () => {
    mocks.channels.mockResolvedValue({ channels: [{ ...channel, online: false, enabled: false }] });
    render(<TeamAi isActive onCreate={vi.fn()} onSelectProject={vi.fn()} onOpenSession={vi.fn()} />);
    expect(await screen.findByText('Planning room')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'teamAi.new' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Budget analysis/ }));
    expect(await screen.findByText('teamAi.offlineHelp')).toBeTruthy();
    expect(mocks.action).not.toHaveBeenCalled();
  });
  it('joins an existing workspace with a usage patch and preserves its identity', async () => {
    mocks.projects = [
      { ...project, displayName: 'Support department', purpose: undefined },
      { ...project, id: 'joined', displayName: 'Already joined' },
      { ...project, id: 'hidden', purpose: undefined, hidden: true },
      { ...project, id: 'internal', purpose: undefined, internal: true },
      { ...project, id: 'archived', purpose: undefined, archivedAt: '2026-10-24T00:00:00Z' },
      { ...project, id: 'no-agent', purpose: undefined, agentId: undefined },
    ];
    const select = vi.fn();
    render(<TeamAi isActive onCreate={vi.fn()} onSelectProject={select} onOpenSession={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'teamAi.join' }));
    const dialog = screen.getByRole('dialog', { name: 'teamAi.selectWorkspaceTitle' });
    expect(within(dialog).getByText('/workspace')).toBeInTheDocument();
    expect(within(dialog).getAllByRole('button')).toHaveLength(2); // close + sole eligible workspace
    expect(within(dialog).queryByText('Already joined')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /Support department/ }));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('workspace', { purpose: 'team-ai' }));
    expect(select).toHaveBeenCalledWith('workspace');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('dismisses the workspace picker with Escape and restores focus without changing config', async () => {
    const user = userEvent.setup();
    mocks.projects = [{ ...project, purpose: undefined }];
    render(<TeamAi isActive onCreate={vi.fn()} onSelectProject={vi.fn()} onOpenSession={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: 'teamAi.join' });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(mocks.patch).not.toHaveBeenCalled();
  });
  it('keeps keyboard focus through pending persistence and the selected-workspace remount', async () => {
    const user = userEvent.setup();
    let complete!: () => void;
    mocks.projects = [{ ...project, purpose: undefined }];
    mocks.patch.mockImplementation(() => new Promise<void>(resolve => { complete = () => { mocks.projects = [project]; resolve(); }; }));
    function SelectedWorkspacePage() {
      const [id, select] = useState<string>();
      return <TeamAi key={id} projectId={id} isActive onCreate={vi.fn()} onSelectProject={select} onOpenSession={vi.fn()} />;
    }
    render(<SelectedWorkspacePage />);
    const trigger = screen.getByRole('button', { name: 'teamAi.join' });
    await user.click(trigger);
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'actions.cancel' })).toHaveFocus());
    await user.keyboard('{Tab}{Enter}');
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute('aria-disabled', 'true');
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    complete();
    await waitFor(() => {
      const nextTrigger = screen.getByRole('button', { name: 'teamAi.join' });
      expect(nextTrigger).not.toBe(trigger);
      expect(nextTrigger).toHaveFocus();
      expect(nextTrigger).toHaveAttribute('aria-disabled', 'false');
    });
  });
  it('distinguishes a failed channel read from an empty channel list', async () => {
    mocks.channels.mockRejectedValue(new Error('State file unreadable'));
    render(<TeamAi isActive onCreate={vi.fn()} onSelectProject={vi.fn()} onOpenSession={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('State file unreadable');
    expect(screen.queryByText('teamAi.noChannels')).toBeNull();
  });
});


describe('Team AI review regressions', () => {
  it('keeps same-platform Bots with identical peer keys separately targeted', async () => {
    mocks.channels.mockResolvedValue({channels:[channel,{...channel,channelId:'bot-b',name:'Second Bot',peers:[{...peer,sessionId:'session-b',sessionIds:['session-a','session-b']}]}]});
    render(<TeamAi isActive onCreate={vi.fn()} onSelectProject={vi.fn()} onOpenSession={vi.fn()} />);
    const rows = await screen.findAllByRole('button',{name:/Budget analysis/});
    fireEvent.contextMenu(rows[1].parentElement!, {clientX:50,clientY:80});
    fireEvent.click(await screen.findByText('teamAi.setPrimary'));
    await waitFor(()=>expect(mocks.action).toHaveBeenCalledWith('agent','bot-b',expect.objectContaining({sessionId:'session-b'}),{kind:'setPrimary',sessionId:'session-a'}));
  });
  it('shows live execution for both the current and still-running historical Session', async () => {
    mocks.states.mockResolvedValue({states:[{channelId:'bot-a',sessionKey:peer.sessionKey,sessionId:'session-a',state:'idle'},{channelId:'bot-a',sessionKey:peer.sessionKey,sessionId:'session-b',state:'running'}]});
    render(<TeamAi isActive onCreate={vi.fn()} onSelectProject={vi.fn()} onOpenSession={vi.fn()} />);
    expect(await screen.findByText('teamAi.states.running')).toBeTruthy();
    expect(screen.getAllByText('teamAi.states.idle').length).toBeGreaterThan(0);
  });
  it('reflects connecting/error instead of treating every live Channel as online', async () => {
    mocks.channels.mockResolvedValue({channels:[{...channel,online:false,status:'connecting'},{...channel,channelId:'bot-b',online:false,status:'error',error:'Transport unavailable'}]});
    render(<TeamAi isActive onCreate={vi.fn()} onSelectProject={vi.fn()} onOpenSession={vi.fn()} />);
    expect(await screen.findByText('teamAi.connecting')).toBeTruthy();
    expect(screen.getByText('teamAi.error')).toBeTruthy();
    expect(screen.getByRole('alert')).toHaveTextContent('Transport unavailable');
    expect(screen.getAllByRole('button',{name:'teamAi.new'}).every(button=>(button as HTMLButtonElement).disabled)).toBe(true);
  });
  it('renders recent live content using the existing message presentation', async () => {
    mocks.detail.mockResolvedValue({session:{...metadata,messages:[{id:'question',role:'user',content:'Synthetic question',timestamp:'2026-10-24T00:00:00Z'}],liveStreamingMessage:{id:'live',role:'assistant',content:JSON.stringify([{type:'text',text:'Synthetic streaming answer'}]),timestamp:'2026-10-24T00:00:01Z'},liveSessionState:'running'}});
    render(<ImagePreviewProvider><TeamAi isActive onCreate={vi.fn()} onSelectProject={vi.fn()} onOpenSession={vi.fn()} /></ImagePreviewProvider>);
    fireEvent.click(await screen.findByRole('button',{name:/Budget analysis/}));
    expect(await screen.findByText('Synthetic streaming answer')).toBeTruthy();
    expect(screen.getByText('Synthetic question')).toBeTruthy();
  });
  it('takes the newly created workspace from the singleton tab selection', async () => {
    mocks.projects=[project,{...project,id:'new-team',agentId:'new-agent',path:'/new-team',name:'New Team'}];
    render(<TeamAi isActive projectId="new-team" onCreate={vi.fn()} onSelectProject={vi.fn()} onOpenSession={vi.fn()} />);
    await waitFor(()=>expect(mocks.channels).toHaveBeenCalledWith('new-agent'));
    expect(screen.getByRole('button',{name:'Team AI'})).toHaveTextContent('New Team');
  });
});
