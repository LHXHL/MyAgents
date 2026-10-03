import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, WorkspaceTemplate } from '@/config/types';
import { ProjectAlreadyExistsError } from '@/config/services/projectService';
import { i18n } from '@/i18n';

const mocks = vi.hoisted(() => ({
  projects: [] as Project[],
  userTemplates: [] as WorkspaceTemplate[],
  addProject: vi.fn(),
  openDialog: vi.fn(),
  invoke: vi.fn(),
  checkPaths: vi.fn(),
  openPathExternal: vi.fn(),
  toastError: vi.fn(),
  track: vi.fn(),
  existingPaths: new Set<string>(),
}));

vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({ projects: mocks.projects, addProject: mocks.addProject }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.openDialog }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/path', () => ({
  join: async (...parts: string[]) => parts.join('/'),
  basename: async (path: string) => path.split('/').filter(Boolean).pop() ?? '',
  homeDir: async () => '/Users/me',
}));
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: async (path: string) => mocks.existingPaths.has(path) }));
vi.mock('@/config/services/templateService', () => ({
  loadUserTemplates: async () => mocks.userTemplates,
  addUserTemplate: vi.fn(),
  removeUserTemplate: vi.fn(),
  updateUserTemplate: vi.fn(),
}));
vi.mock('@/hooks/useWorkspaceFileService', () => ({
  useWorkspaceFileService: () => ({ checkPaths: mocks.checkPaths, openPathExternal: mocks.openPathExternal }),
}));
vi.mock('@/components/Toast', () => ({
  useToast: () => ({ error: mocks.toastError, success: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));
vi.mock('@/analytics', () => ({ track: mocks.track }));
vi.mock('@/utils/browserMock', () => ({ isBrowserDevMode: () => false, pickFolderForDialog: vi.fn() }));

import NewAgentPanel from './NewAgentPanel';

const tl = (key: string, options?: Record<string, unknown>) => String(i18n.t(`launcher:${key}`, options));

function project(overrides: Partial<Project> & Pick<Project, 'id' | 'path'>): Project {
  return { name: 'p', lastOpened: '', providerId: null, permissionMode: null, ...overrides };
}

function renderPanel() {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(<NewAgentPanel onClose={onClose} onCreated={onCreated} />);
  return { onClose, onCreated };
}

function createButton() {
  return screen.getByRole('button', { name: tl('newAgentPanel.create') });
}

beforeEach(() => {
  mocks.projects = [];
  mocks.userTemplates = [];
  mocks.existingPaths = new Set();
  mocks.addProject.mockReset().mockImplementation(async (path: string) => project({ id: 'new', path }));
  mocks.openDialog.mockReset();
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.checkPaths.mockReset().mockResolvedValue({ results: {} });
  mocks.openPathExternal.mockReset();
  mocks.toastError.mockReset();
  mocks.track.mockReset();
});

describe('NewAgentPanel list', () => {
  it('lists official kinds first, then my templates and the add-template row', async () => {
    mocks.userTemplates = [{ id: 'research', name: '研究助手', description: '', isBuiltin: false, path: '/t/research', icon: 'book' }];
    renderPanel();

    const list = await screen.findByText('研究助手').then((node) => node.closest('[data-new-agent-panel-list]') as HTMLElement);
    const labels = within(list).getAllByRole('button').map((button) => button.textContent ?? '');
    expect(labels[0]).toContain(tl('newAgentPanel.local.title'));
    expect(labels[1]).toContain(tl('newAgentPanel.mino.title'));
    expect(labels[1]).toContain(tl('newAgentPanel.recommended'));
    expect(labels[2]).toContain('研究助手');
    expect(labels[2]).toContain(tl('newAgentPanel.noDescription'));
    expect(labels[3]).toContain(tl('newAgentPanel.addTemplate'));
    expect(within(list).getByText(tl('newAgentPanel.myTemplates'))).toBeInTheDocument();
  });

  it('closes on Escape from the list', () => {
    const { onClose } = renderPanel();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('NewAgentPanel local project', () => {
  it('discards an already registered folder and stays on the list', async () => {
    mocks.projects = [project({ id: 'a', path: '/work/app' })];
    mocks.openDialog.mockResolvedValue('/work/app');
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: new RegExp(tl('newAgentPanel.local.title')) }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(tl('newAgentPanel.errors.exists')));
    expect(screen.queryByRole('button', { name: tl('newAgentPanel.create') })).not.toBeInTheDocument();
  });

  it('reports archived folders distinctly', async () => {
    mocks.projects = [project({ id: 'a', path: '/work/old', archivedAt: '2026-01-01T00:00:00.000Z' })];
    mocks.openDialog.mockResolvedValue('/work/old');
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: new RegExp(tl('newAgentPanel.local.title')) }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(tl('newAgentPanel.errors.archived')));
  });

  it('opens the detail page for a new folder and creates with the create-only policy', async () => {
    mocks.openDialog.mockResolvedValue('/work/my-app');
    mocks.checkPaths.mockResolvedValue({ results: { 'AGENTS.md': { exists: true, type: 'file' } } });
    const { onCreated, onClose } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: new RegExp(tl('newAgentPanel.local.title')) }));

    const nameInput = await screen.findByRole('textbox', { name: tl('newAgentPanel.nameLabel') });
    expect(nameInput).toHaveValue('my-app');
    expect(screen.getByText(tl('newAgentPanel.local.intro', { name: 'my-app' }))).toBeInTheDocument();
    expect(await screen.findByText(tl('newAgentPanel.local.capInstructionsFoundTitle', { file: 'AGENTS.md' }))).toBeInTheDocument();
    expect(screen.getByText(tl('newAgentPanel.capChannelsTitle'))).toBeInTheDocument();

    fireEvent.change(nameInput, { target: { value: '我的应用' } });
    fireEvent.click(createButton());

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(mocks.addProject).toHaveBeenCalledWith('/work/my-app', {
      displayName: '我的应用',
      icon: undefined,
      onExisting: 'reject',
    });
    expect(mocks.track).toHaveBeenCalledWith('workspace_create', { source: 'local' });
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the detail page when the folder was registered meanwhile', async () => {
    mocks.openDialog.mockResolvedValue('/work/my-app');
    const { onCreated } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(tl('newAgentPanel.local.title')) }));
    await screen.findByRole('textbox', { name: tl('newAgentPanel.nameLabel') });

    mocks.addProject.mockRejectedValue(new ProjectAlreadyExistsError(project({ id: 'a', path: '/work/my-app' })));
    fireEvent.click(createButton());

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(tl('newAgentPanel.errors.exists')));
    expect(onCreated).not.toHaveBeenCalled();
    expect(createButton()).toBeInTheDocument();
  });

  it('keeps the previous path when re-picking an existing workspace', async () => {
    mocks.projects = [project({ id: 'a', path: '/work/app' })];
    mocks.openDialog.mockResolvedValueOnce('/work/my-app').mockResolvedValueOnce('/work/app');
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(tl('newAgentPanel.local.title')) }));
    await screen.findByRole('textbox', { name: tl('newAgentPanel.nameLabel') });

    fireEvent.click(screen.getByRole('button', { name: tl('newAgentPanel.changePath') }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(tl('newAgentPanel.errors.exists')));
    expect(document.querySelector('[data-new-agent-panel-path]')?.textContent).toContain('my-app');
  });
});

describe('NewAgentPanel Mino', () => {
  async function openMino() {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(tl('newAgentPanel.mino.title')) }));
    return screen.findByRole('textbox', { name: tl('newAgentPanel.nameLabel') });
  }

  it('shows three capabilities without toggles and the final suffixed path', async () => {
    mocks.existingPaths = new Set(['/Users/me/.myagents/projects/mino']);
    const nameInput = await openMino();

    expect(nameInput).toHaveValue('mino');
    const capabilities = document.querySelector('[data-new-agent-panel-capabilities]') as HTMLElement;
    expect(within(capabilities).getAllByRole('listitem')).toHaveLength(3);
    expect(within(capabilities).getByText(tl('newAgentPanel.mino.capEvolveTitle'))).toBeInTheDocument();
    expect(within(capabilities).getByText(tl('newAgentPanel.mino.capSkillsTitle'))).toBeInTheDocument();
    expect(within(capabilities).getByText(tl('newAgentPanel.capChannelsTitle'))).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[data-new-agent-panel-path]')?.textContent).toContain('mino-2'));
  });

  it('creates from the bundled template with Agent defaults', async () => {
    await openMino();
    fireEvent.click(createButton());

    await waitFor(() => expect(mocks.addProject).toHaveBeenCalled());
    expect(mocks.invoke).toHaveBeenCalledWith('cmd_create_workspace_from_bundled_template', {
      templateId: 'mino',
      destPath: '/Users/me/.myagents/projects/mino',
    });
    const [path, options] = mocks.addProject.mock.calls[0];
    expect(path).toBe('/Users/me/.myagents/projects/mino');
    expect(options).toMatchObject({
      displayName: 'mino',
      icon: 'lightning',
      templateId: 'mino',
      templateSource: 'builtin',
      onExisting: 'reject',
    });
    expect(options.agentDefaults?.heartbeat?.enabled).toBe(true);
  });

  it('disables creation for an empty name and goes back on Escape', async () => {
    const nameInput = await openMino();
    fireEvent.change(nameInput, { target: { value: '   ' } });
    expect(createButton()).toBeDisabled();

    fireEvent.keyDown(nameInput, { key: 'Escape' });
    expect(await screen.findByText(tl('newAgentPanel.myTemplates'))).toBeInTheDocument();
  });

  it('uses the shared icon library and passes the chosen icon', async () => {
    await openMino();
    fireEvent.click(screen.getByRole('button', { name: tl('newAgentPanel.changeIcon') }));
    const fox = await screen.findByTitle('fox');
    await act(async () => {
      fireEvent.click(fox);
    });
    fireEvent.click(createButton());

    await waitFor(() => expect(mocks.addProject).toHaveBeenCalled());
    expect(mocks.addProject.mock.calls[0][1]).toMatchObject({ icon: 'fox' });
  });
});

describe('NewAgentPanel keyboard and busy states', () => {
  async function openMino() {
    const handlers = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(tl('newAgentPanel.mino.title')) }));
    await screen.findByRole('textbox', { name: tl('newAgentPanel.nameLabel') });
    return handlers;
  }

  it('goes back then closes on Escape even when focus fell to <body>', async () => {
    const { onClose } = await openMino();
    (document.activeElement as HTMLElement | null)?.blur();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(await screen.findByText(tl('newAgentPanel.myTemplates'))).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes only the icon popover on the first Escape', async () => {
    await openMino();
    fireEvent.click(screen.getByRole('button', { name: tl('newAgentPanel.changeIcon') }));
    await screen.findByTitle('fox');

    fireEvent.keyDown(document.body, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByTitle('fox')).not.toBeInTheDocument());
    expect(createButton()).toBeInTheDocument();
  });

  it('cannot be closed or resubmitted while creating', async () => {
    const { onClose } = await openMino();
    mocks.addProject.mockReturnValue(new Promise(() => undefined));
    fireEvent.click(createButton());
    await waitFor(() => expect(mocks.addProject).toHaveBeenCalledTimes(1));

    expect(createButton()).toBeDisabled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: tl('newAgentPanel.close') }));
    fireEvent.click(createButton());
    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.addProject).toHaveBeenCalledTimes(1);
  });

  it('stays on the detail page with an error when the template copy fails', async () => {
    const { onCreated } = await openMino();
    mocks.invoke.mockRejectedValue(new Error('disk full'));
    fireEvent.click(createButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('disk full');
    expect(mocks.addProject).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('follows the name in the previewed folder path', async () => {
    await openMino();
    fireEvent.change(screen.getByRole('textbox', { name: tl('newAgentPanel.nameLabel') }), { target: { value: 'My: Agent' } });
    await waitFor(() => expect(document.querySelector('[data-new-agent-panel-path]')?.textContent).toContain('My- Agent'));
  });
});

describe('NewAgentPanel user template', () => {
  it('shows detected template contents and copies the template on create', async () => {
    mocks.userTemplates = [{ id: 'research', name: '研究助手', description: '读论文', isBuiltin: false, path: '/t/research', icon: 'book' }];
    mocks.checkPaths.mockResolvedValue({ results: {
      'CLAUDE.md': { exists: true, type: 'file' },
      '.claude/skills': { exists: true, type: 'dir' },
    } });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /研究助手/ }));
    expect(await screen.findByText('.claude/skills/')).toBeInTheDocument();
    expect(screen.getByText('CLAUDE.md')).toBeInTheDocument();
    expect(screen.getByText('读论文')).toBeInTheDocument();

    fireEvent.click(createButton());
    await waitFor(() => expect(mocks.addProject).toHaveBeenCalled());
    expect(mocks.invoke).toHaveBeenCalledWith('cmd_create_workspace_from_template', {
      sourcePath: '/t/research',
      destPath: '/Users/me/.myagents/projects/研究助手',
    });
    expect(mocks.addProject.mock.calls[0][1]).toMatchObject({
      displayName: '研究助手',
      templateId: 'research',
      templateSource: 'user',
      agentDefaults: undefined,
    });
  });
});
