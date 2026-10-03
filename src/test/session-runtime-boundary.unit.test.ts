import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint({ cwd: process.cwd() });
const boundaryRules = new Set(['@typescript-eslint/no-restricted-imports', 'no-restricted-syntax']);

async function boundaryErrors(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter(message => message.fatal || boundaryRules.has(message.ruleId ?? ''));
}

describe('Session Runtime configuration import boundary', () => {
  it.each([
    "import { setMcpServers } from './agent-session';",
    "import { setAgents as reloadAgents } from './agent-session';",
    "import { forceReloadActiveSession } from '@/server/agent-session';",
    "import * as sdk from './agent-session';",
    "const sdk = await import('./agent-session');",
  ])('rejects the SDK configuration bypass: %s', async code => {
    expect(await boundaryErrors(code, 'src/server/admin-api.ts')).not.toHaveLength(0);
  });

  it('also enforces the boundary on session routes', async () => {
    const code = "import { schedulePluginDeferredRestart } from '../agent-session';";
    expect(await boundaryErrors(code, 'src/server/routes/session-config.ts')).not.toHaveLength(0);
  });

  it('allows the selected engine and SDK read-only imports in Admin handlers', async () => {
    const code = "import { getSessionEngine } from './session-engine';\nimport { getSidecarPort, SDK_RESERVED_MCP_NAMES } from './agent-session';";
    expect(await boundaryErrors(code, 'src/server/admin-api.ts')).toEqual([]);
  });

  it('allows the builtin adapter to own SDK configuration and reload', async () => {
    const code = "import { setMcpServers, setAgents, forceReloadActiveSession } from '../agent-session';";
    expect(await boundaryErrors(code, 'src/server/session-engine/builtin-adapter.ts')).toEqual([]);
  });
});
