import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../types';

const state = vi.hoisted(() => ({
  projects: [] as Project[],
  writes: 0,
}));

vi.mock('./configStore', () => ({
  isBrowserDevMode: () => false,
  withProjectsLock: <T>(fn: () => Promise<T>) => fn(),
  ensureConfigDir: async () => undefined,
  getConfigDir: async () => '/cfg',
  PROJECTS_FILE: 'projects.json',
  safeLoadJson: async () => structuredClone(state.projects),
  safeWriteJson: async (_path: string, data: Project[]) => {
    state.writes += 1;
    state.projects = structuredClone(data);
  },
}));

vi.mock('./configEvents', () => ({ notifyConfigChanged: vi.fn() }));

vi.mock('@/utils/browserMock', () => ({
  mockLoadProjects: vi.fn(() => []),
  mockSaveProjects: vi.fn(),
  mockAddProject: vi.fn(),
}));

vi.mock('@tauri-apps/api/path', () => ({
  join: async (...parts: string[]) => parts.join('/'),
  basename: async (path: string) => path.split('/').filter(Boolean).pop() ?? '',
}));

import { addProject, findBlockingProject, ProjectAlreadyExistsError } from './projectService';

function project(overrides: Partial<Project> & Pick<Project, 'id' | 'path'>): Project {
  return {
    name: overrides.path.split('/').pop() ?? 'p',
    lastOpened: '2026-01-01T00:00:00.000Z',
    providerId: null,
    permissionMode: null,
    ...overrides,
  };
}

describe('addProject create-only policy', () => {
  beforeEach(() => {
    state.projects = [];
    state.writes = 0;
  });

  it('rejects an active workspace without touching any field', async () => {
    const existing = project({ id: 'a', path: '/work/app', displayName: 'Old', icon: 'fox' });
    state.projects = [existing];

    const error = await addProject('/work/app', { notification: 'deferred', onExisting: 'reject' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProjectAlreadyExistsError);
    expect((error as ProjectAlreadyExistsError).archived).toBe(false);
    expect((error as ProjectAlreadyExistsError).project.id).toBe('a');
    expect(state.writes).toBe(0);
    expect(state.projects).toEqual([existing]);
  });

  it('rejects an archived workspace and reports it as archived', async () => {
    state.projects = [project({ id: 'a', path: '/work/app', archivedAt: '2026-02-01T00:00:00.000Z' })];

    const error = await addProject('/work/app', { notification: 'deferred', onExisting: 'reject' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProjectAlreadyExistsError);
    expect((error as ProjectAlreadyExistsError).archived).toBe(true);
    expect(state.writes).toBe(0);
  });

  it('treats a hidden (soft-deleted) workspace as absent', async () => {
    state.projects = [project({ id: 'a', path: '/work/app', hidden: true })];

    const result = await addProject('/work/app', { notification: 'deferred', onExisting: 'reject' });

    expect(result.id).toBe('a');
    expect(state.writes).toBe(1);
  });

  it('keeps the default reuse behavior for other callers', async () => {
    state.projects = [project({ id: 'a', path: '/work/app' })];

    const result = await addProject('/work/app', { notification: 'deferred' });

    expect(result.id).toBe('a');
    expect(state.writes).toBe(1);
    expect(state.projects[0].lastOpened).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it('creates a new workspace when the path is free', async () => {
    const result = await addProject('/work/new', { notification: 'deferred', onExisting: 'reject' });

    expect(result.path).toBe('/work/new');
    expect(state.projects.map((p) => p.path)).toEqual(['/work/new']);
  });
});

describe('findBlockingProject', () => {
  it('matches canonical path identity and ignores hidden projects', () => {
    const active = project({ id: 'a', path: '/work/app' });
    const hidden = project({ id: 'b', path: '/work/old', hidden: true });

    expect(findBlockingProject([active, hidden], '/work/app/')).toBe(active);
    expect(findBlockingProject([active, hidden], '/work/old')).toBeUndefined();
  });
});
