/**
 * Pure rules for the New Agent panel. Kept DOM/IO-free so the decisions the
 * PRD fixes (folder-name derivation, conflict classification, detected
 * project-instruction / template content) are unit-testable.
 */

import { isProjectArchived, type Project } from '@/config/types';
import { findBlockingProject } from '@/config/services/projectService';

// Characters that are invalid in a file name on at least one of
// Windows / macOS / Linux, plus ASCII control characters.
// eslint-disable-next-line no-control-regex -- control characters are exactly what we strip
const ILLEGAL_FOLDER_CHARS = /[/\\:*?"<>|\u0000-\u001f\u007f]/g;

/**
 * Folder name created for a template-based Agent. The display name keeps the
 * user's raw input; only the on-disk folder is sanitized. Returns `''` when
 * nothing usable remains (the panel then disables "Create Agent").
 */
export function deriveWorkspaceFolderName(name: string): string {
  return name
    .trim()
    .replace(ILLEGAL_FOLDER_CHARS, '-')
    // Windows silently drops trailing dots/spaces, which would desync the
    // previewed path from the real one.
    .replace(/[. ]+$/, '')
    .trim();
}

export type FolderConflict = { kind: 'exists' | 'archived'; project: Project };

/** Same decision table as the in-lock create-only check in `addProject`. */
export function classifyFolderConflict(projects: readonly Project[], path: string): FolderConflict | null {
  const project = findBlockingProject(projects, path);
  if (!project) return null;
  return {
    kind: isProjectArchived(project) ? 'archived' : 'exists',
    project,
  };
}

/** Project-instruction files Runtimes load from a workspace root, in display priority. */
export const PROJECT_INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md'] as const;

/** Template root entries surfaced as "template contents" tags. */
export const TEMPLATE_CONTENT_ENTRIES = [
  { path: 'CLAUDE.md', type: 'file', label: 'CLAUDE.md' },
  { path: 'AGENTS.md', type: 'file', label: 'AGENTS.md' },
  { path: '.claude/skills', type: 'dir', label: '.claude/skills/' },
  { path: '.claude/rules', type: 'dir', label: '.claude/rules/' },
] as const;

export type CheckedPaths = Record<string, { exists: boolean; type?: string } | undefined>;

export function detectProjectInstructionFile(results: CheckedPaths): string | null {
  return PROJECT_INSTRUCTION_FILES.find((file) => results[file]?.exists && results[file]?.type === 'file') ?? null;
}

export function detectTemplateContents(results: CheckedPaths): string[] {
  return TEMPLATE_CONTENT_ENTRIES
    .filter((entry) => results[entry.path]?.exists && results[entry.path]?.type === entry.type)
    .map((entry) => entry.label);
}

/** Split an absolute path into the parent prefix (with trailing separator) and the last segment. */
export function splitPathForDisplay(path: string): { parent: string; leaf: string } {
  const trimmed = path.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (index < 0) return { parent: '', leaf: trimmed };
  return { parent: trimmed.slice(0, index + 1), leaf: trimmed.slice(index + 1) };
}

/** Separator to append a child to `parent` for display, matching its style. */
export function displaySeparator(parent: string): string {
  return parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
}
