import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXTERNAL_CLI_PUBLIC_CAPABILITIES } from './externalCliCapabilities';

const GUIDE_PATH = resolve(
  process.cwd(),
  'bundled-guides/external-myagents-cli/SKILL.md',
);
const guide = readFileSync(GUIDE_PATH, 'utf8');
const documentedInvocations = [
  ...guide.matchAll(/^(?:\d+\.\s+)?<CLI> ([^\n]+)$/gm),
].map(([, invocation]) => invocation.trim());
const publicCommands = EXTERNAL_CLI_PUBLIC_CAPABILITIES.map(
  ({ command }) => command,
);

describe('external MyAgents CLI guide', () => {
  it('declares every capability in the external admission allowlist exactly', () => {
    const exactDeclarations = new Set(documentedInvocations);
    for (const command of publicCommands) {
      expect(
        exactDeclarations.has(command),
        `missing exact public command declaration: ${command}`,
      ).toBe(true);
    }
  });

  it('never demonstrates an invocation outside the public allowlist', () => {
    for (const invocation of documentedInvocations) {
      if (invocation === '--help') continue;
      const matchingCommands = publicCommands.filter(
        (command) =>
          invocation === command || invocation.startsWith(`${command} `),
      );
      expect(
        matchingCommands,
        `unsupported external CLI invocation: ${invocation}`,
      ).not.toHaveLength(0);
    }
  });

  it('keeps internal caller credentials and direct control-plane details out', () => {
    expect(guide).not.toContain('MYAGENTS_INTERNAL_CLI_TOKEN');
    expect(guide).not.toContain('MYAGENTS_PORT');
    expect(guide).not.toContain('/api/admin/');
  });

  it('requires the absolute launcher and external token environment variable', () => {
    expect(guide).toContain('MyAgents CLI 绝对路径');
    expect(guide).toContain('MYAGENTS_API_TOKEN');
    expect(guide).toContain('不要假设 PATH 中存在 `myagents`');
  });
});
