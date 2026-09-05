import type { PermissionOperationDisplay } from '../../../shared/types/runtime';

/** Older Runtime artifacts omit display; retain the existing permission summary. */
export function dshPermissionDisplay(schema: Record<string, unknown>): PermissionOperationDisplay | undefined {
  const display = schema.display;
  if (schema.tool !== 'Bash' || schema.permissionClass !== 'process.execute'
    || !display || typeof display !== 'object' || Array.isArray(display)) return undefined;
  const value = display as Record<string, unknown>;
  if (typeof value.command !== 'string' || typeof value.cwd !== 'string') return undefined;
  return {
    command: value.command,
    cwd: value.cwd,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    alwaysAllowScope: 'session_workspace',
  };
}
