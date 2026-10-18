import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_GLOBAL_SIDEBAR_PREFERENCE,
  GLOBAL_SIDEBAR_PREFERENCE_KEY,
  normalizeGlobalSidebarWidth,
  saveGlobalSidebarPreference,
  LEGACY_AUTOMATION_HISTORY_KEY,
  loadGlobalSidebarPreference,
  parseGlobalSidebarPreference,
  pruneRemovedWorkspaceKeys,
  resolveGlobalSidebarMode,
  seedDefaultWorkspaceExpansion,
} from './globalSidebarPreference';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
    values,
  };
}

describe('globalSidebarPreference', () => {
  it.each([undefined, null, '300', NaN, Infinity, -Infinity])('defaults invalid width %s', (value) => {
    expect(normalizeGlobalSidebarWidth(value)).toBe(256);
  });

  it.each([[200, 224], [360, 360], [420, 420], [600, 480], [301.6, 302], [256, 256]])('normalizes width %s to %s', (input, expected) => {
    expect(normalizeGlobalSidebarWidth(input)).toBe(expected);
  });

  it('upgrades old preferences without losing existing choices', () => {
    const old = { version: 1, preferredMode: 'rail', hasSeededDefaultExpansion: true,
      expandedWorkspaceKeys: ['/work/a'], showAutomationSessions: true, sessionView: 'favorites' };
    expect(parseGlobalSidebarPreference(old)).toEqual({ ...old, expandedWidth: 256 });
    expect(parseGlobalSidebarPreference({ ...old, expandedWidth: 'broken' })).toEqual({ ...old, expandedWidth: 256 });
    const storage = memoryStorage();
    expect(saveGlobalSidebarPreference(storage, { ...DEFAULT_GLOBAL_SIDEBAR_PREFERENCE, expandedWidth: 312 })).toBe(true);
    expect(loadGlobalSidebarPreference(storage).expandedWidth).toBe(312);
  });

  it('keeps the sidebar usable when storage cannot be read or written', () => {
    const storage = memoryStorage();
    storage.getItem.mockImplementation(() => { throw new Error('blocked'); });
    expect(loadGlobalSidebarPreference(storage)).toEqual(DEFAULT_GLOBAL_SIDEBAR_PREFERENCE);
    storage.setItem.mockImplementation(() => { throw new Error('full'); });
    expect(saveGlobalSidebarPreference(storage, DEFAULT_GLOBAL_SIDEBAR_PREFERENCE)).toBe(false);
  });

  it('fails soft on malformed or unsupported persisted values', () => {
    expect(parseGlobalSidebarPreference({ version: 2 })).toBeNull();
    const storage = memoryStorage({ [GLOBAL_SIDEBAR_PREFERENCE_KEY]: '{broken' });
    expect(loadGlobalSidebarPreference(storage)).toEqual(DEFAULT_GLOBAL_SIDEBAR_PREFERENCE);
  });

  it('migrates the old automation history choice once', () => {
    const storage = memoryStorage({ [LEGACY_AUTOMATION_HISTORY_KEY]: 'true' });
    const preference = loadGlobalSidebarPreference(storage);
    expect(preference.showAutomationSessions).toBe(true);
    expect(storage.removeItem).toHaveBeenCalledWith(LEGACY_AUTOMATION_HISTORY_KEY);
    expect(JSON.parse(storage.values.get(GLOBAL_SIDEBAR_PREFERENCE_KEY) ?? '{}')).toMatchObject({
      version: 1,
      showAutomationSessions: true,
    });
  });

  it('seeds only a valid default workspace and never reseeds after user ownership', () => {
    const untouched = seedDefaultWorkspaceExpansion(
      DEFAULT_GLOBAL_SIDEBAR_PREFERENCE,
      '/work/mino',
      ['/work/other'],
    );
    expect(untouched).toBe(DEFAULT_GLOBAL_SIDEBAR_PREFERENCE);

    const seeded = seedDefaultWorkspaceExpansion(
      DEFAULT_GLOBAL_SIDEBAR_PREFERENCE,
      '/work/mino/',
      ['/work/mino'],
    );
    expect(seeded.hasSeededDefaultExpansion).toBe(true);
    expect(seeded.expandedWorkspaceKeys).toEqual(['/work/mino']);

    const userCollapsed = { ...seeded, expandedWorkspaceKeys: [] };
    expect(seedDefaultWorkspaceExpansion(userCollapsed, '/work/mino', ['/work/mino'])).toBe(userCollapsed);
  });

  it('prunes removed workspaces and keeps automatic rail separate from preference', () => {
    const preference = {
      ...DEFAULT_GLOBAL_SIDEBAR_PREFERENCE,
      preferredMode: 'expanded' as const,
      expandedWorkspaceKeys: ['/work/a', '/work/b'],
    };
    expect(pruneRemovedWorkspaceKeys(preference, ['/work/b']).expandedWorkspaceKeys).toEqual(['/work/b']);
    expect(resolveGlobalSidebarMode(preference.preferredMode, true)).toBe('rail');
    expect(resolveGlobalSidebarMode(preference.preferredMode, false)).toBe('expanded');
  });
});
