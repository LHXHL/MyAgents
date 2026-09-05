import { describe, expect, it } from 'vitest';
import { dshPermissionDisplay } from './permission-display';

describe('DSH permission operation display', () => {
  it.each(['Bash', 'bash', 'pwsh'])('preserves full command bytes and annotates the existing workspace permission scope for %s', (tool) => {
    const display = { command: `printf '%s' '${'示例'.repeat(600)}'\nprintf done`, cwd: '/workspace', description: 'Inspect' };
    expect(dshPermissionDisplay({ tool, permissionClass: 'process.execute', target: '/workspace', display }))
      .toEqual({ ...display, alwaysAllowScope: 'session_workspace' });
  });

  it('keeps old artifacts and other interaction shapes on the existing summary path', () => {
    expect(dshPermissionDisplay({ tool: 'Bash', permissionClass: 'process.execute' })).toBeUndefined();
    expect(dshPermissionDisplay({ tool: 'AskUserQuestion', display: { command: 'example', cwd: '/workspace' } })).toBeUndefined();
  });
});
