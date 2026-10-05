import { describe, expect, it } from 'vitest';

import type { Project } from '@/config/types';
import {
  classifyFolderConflict,
  deriveWorkspaceFolderName,
  detectProjectInstructionFile,
  detectTemplateContents,
  splitPathForDisplay,
} from './newAgentPanelModel';

function project(overrides: Partial<Project> & Pick<Project, 'id' | 'path'>): Project {
  return { name: 'p', lastOpened: '', providerId: null, permissionMode: null, ...overrides };
}

describe('deriveWorkspaceFolderName', () => {
  it('keeps ordinary names, including CJK and inner spaces', () => {
    expect(deriveWorkspaceFolderName('mino')).toBe('mino');
    expect(deriveWorkspaceFolderName('  研究 助手  ')).toBe('研究 助手');
  });

  it('replaces characters that are illegal on any desktop platform', () => {
    expect(deriveWorkspaceFolderName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
    expect(deriveWorkspaceFolderName('tab\there')).toBe('tab-here');
  });

  it('drops trailing dots and spaces that Windows would silently strip', () => {
    expect(deriveWorkspaceFolderName('agent. . ')).toBe('agent');
  });

  it('returns empty when nothing usable remains', () => {
    expect(deriveWorkspaceFolderName('   ')).toBe('');
    expect(deriveWorkspaceFolderName('...')).toBe('');
  });
});

describe('classifyFolderConflict', () => {
  it('distinguishes active, archived and hidden workspaces', () => {
    const projects = [
      project({ id: 'a', path: '/work/app' }),
      project({ id: 'b', path: '/work/old', archivedAt: '2026-01-01T00:00:00.000Z' }),
      project({ id: 'c', path: '/work/gone', hidden: true }),
    ];

    expect(classifyFolderConflict(projects, '/work/app')?.kind).toBe('exists');
    expect(classifyFolderConflict(projects, '/work/old')?.kind).toBe('archived');
    expect(classifyFolderConflict(projects, '/work/gone')).toBeNull();
    expect(classifyFolderConflict(projects, '/work/new')).toBeNull();
  });
});

describe('detection', () => {
  it('prefers CLAUDE.md, then AGENTS.md, and requires a file', () => {
    expect(detectProjectInstructionFile({ 'AGENTS.md': { exists: true, type: 'file' } })).toBe('AGENTS.md');
    expect(detectProjectInstructionFile({
      'CLAUDE.md': { exists: true, type: 'file' },
      'AGENTS.md': { exists: true, type: 'file' },
    })).toBe('CLAUDE.md');
    expect(detectProjectInstructionFile({ 'CLAUDE.md': { exists: true, type: 'dir' } })).toBeNull();
    expect(detectProjectInstructionFile({})).toBeNull();
  });

  it('lists only template entries of the expected kind', () => {
    expect(detectTemplateContents({
      'AGENTS.md': { exists: true, type: 'file' },
      '.claude/skills': { exists: true, type: 'dir' },
      '.claude/rules': { exists: false },
    })).toEqual(['AGENTS.md', '.claude/skills/']);
  });
});

describe('splitPathForDisplay', () => {
  it('handles POSIX and Windows separators', () => {
    expect(splitPathForDisplay('/Users/me/Projects/my-app')).toEqual({ parent: '/Users/me/Projects/', leaf: 'my-app' });
    expect(splitPathForDisplay('D:\\work\\my-app\\')).toEqual({ parent: 'D:\\work\\', leaf: 'my-app' });
  });
});
