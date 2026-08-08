import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const pluginStore = vi.hoisted(() => ({
  entries: [] as Array<{ id: string; enabled: boolean; installPath: string }>,
}));

vi.mock('../../../plugins/store', () => ({
  getDefaultEnabledPluginIdsForWorkspace: () => pluginStore.entries.map(entry => entry.id),
  getEnabledPluginSdkConfigs: (ids: readonly string[]) => pluginStore.entries
    .filter(entry => ids.includes(entry.id))
    .map(entry => ({ path: entry.installPath })),
  listInstalledPlugins: () => pluginStore.entries,
}));
import {
  compileManagedCodexCommand,
  compileManagedCodexExtensionSnapshot,
} from './compiler';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'myagents-managed-codex-'));
  roots.push(root);
  return root;
}

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

afterEach(() => {
  pluginStore.entries = [];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Managed Codex extension compiler', () => {
  it('compiles deterministic project/global Commands, Skills, and native Agent roles', () => {
    const workspace = tempRoot();
    const userRoot = tempRoot();
    write(join(workspace, '.claude', 'commands', 'review.md'), [
      '---',
      'name: review-local',
      'description: Review locally',
      '---',
      'Inspect $ARGUMENTS carefully.',
    ].join('\n'));
    write(join(userRoot, 'commands', 'review.md'), [
      '---',
      'name: review-local',
      'description: Global duplicate',
      '---',
      'Global body.',
    ].join('\n'));
    write(join(workspace, '.claude', 'skills', 'testing', 'SKILL.md'), [
      '---',
      'name: testing',
      'description: Test the implementation',
      '---',
      'Run focused tests.',
    ].join('\n'));
    write(join(userRoot, 'skills', 'testing', 'SKILL.md'), [
      '---',
      'name: testing',
      'description: Global duplicate',
      '---',
      'Global test instructions.',
    ].join('\n'));
    write(join(workspace, '.claude', 'agents', 'reviewer.md'), [
      '---',
      'name: reviewer',
      'description: Reviews changes',
      'model: inherit',
      'skills:',
      '  - testing',
      '---',
      'Review the requested changes.',
    ].join('\n'));
    write(join(workspace, '.claude', 'agents', 'limited.md'), [
      '---',
      'name: limited',
      'description: Unsupported tool-limited role',
      'tools: Read',
      '---',
      'Read only.',
    ].join('\n'));
    write(join(workspace, '.claude', 'agents', 'claude-model.md'), [
      '---',
      'name: claude-model',
      'description: Uses a Claude-only alias',
      'model: sonnet',
      '---',
      'Review with Sonnet.',
    ].join('\n'));
    write(join(workspace, '.claude', 'agents', 'stateful.md'), [
      '---',
      'name: stateful',
      'description: Uses unsupported Claude lifecycle fields',
      'permissionMode: plan',
      'memory: project',
      'hooks:',
      '  Stop: []',
      '---',
      'Keep state.',
    ].join('\n'));

    const snapshot = compileManagedCodexExtensionSnapshot({
      workspacePath: workspace,
      userConfigRoot: userRoot,
      enabledPluginIds: [],
      mcpServers: [],
      scenario: { type: 'desktop', surface: 'chat' },
    });

    expect(snapshot.commands).toMatchObject([{
      name: 'review-local',
      body: 'Inspect $ARGUMENTS carefully.',
      scope: 'project',
    }]);
    expect(snapshot.skills).toHaveLength(1);
    expect(snapshot.skills[0]).toMatchObject({ name: 'testing', scope: 'project' });
    expect(snapshot.agents).toMatchObject([{
      name: 'reviewer',
      prompt: 'Review the requested changes.',
      skills: [{ name: 'testing' }],
    }]);
    expect(snapshot.components).toContainEqual(expect.objectContaining({
      component: 'agents',
      id: 'workspace:limited',
      state: 'unsupported',
      code: 'agent_unsupported_fields',
    }));
    expect(snapshot.components).toContainEqual(expect.objectContaining({
      component: 'agents',
      id: 'workspace:claude-model',
      state: 'unsupported',
      code: 'agent_unsupported_fields',
      message: 'Unsupported fields: model',
    }));
    expect(snapshot.components).toContainEqual(expect.objectContaining({
      component: 'agents',
      id: 'workspace:stateful',
      state: 'unsupported',
      message: 'Unsupported fields: permissionMode, memory, hooks',
    }));
    expect(snapshot.components).toContainEqual(expect.objectContaining({
      component: 'commands',
      id: 'global:review-local',
      state: 'not_applicable',
      code: 'command_shadowed',
    }));

    expect(compileManagedCodexCommand('/review-local src/server', snapshot)).toMatchObject({
      rawText: '/review-local src/server',
      runtimeText: 'Inspect src/server carefully.',
      revision: snapshot.revision,
    });
    expect(() => compileManagedCodexCommand('/missing input', snapshot)).toThrow(
      'Unknown Managed Codex command: /missing',
    );
    expect(compileManagedCodexCommand('/compact', snapshot)).toBeNull();
  });

  it('appends arguments when a Command omits $ARGUMENTS and keeps secrets out of revisions', () => {
    const workspace = tempRoot();
    const userRoot = tempRoot();
    write(join(workspace, '.claude', 'commands', 'triage.md'), [
      '---',
      'name: triage',
      'description: Triage an issue',
      '---',
      'Triage this issue.',
    ].join('\n'));

    const compile = (token: string) => compileManagedCodexExtensionSnapshot({
      workspacePath: workspace,
      userConfigRoot: userRoot,
      enabledPluginIds: [],
      scenario: { type: 'desktop' },
      mcpServers: [{
        id: 'remote',
        name: 'Remote',
        type: 'stdio',
        command: 'server',
        env: { API_TOKEN: token },
        isBuiltin: false,
      }],
    });
    const first = compile('secret-one');
    const second = compile('secret-two');

    expect(first.revision).toBe(second.revision);
    expect(first.revision).not.toContain('secret-one');
    expect(compileManagedCodexCommand('/triage #123', first)?.runtimeText).toBe(
      'Triage this issue.\n\nArguments:\n#123',
    );
  });

  it('advances the revision when only trusted Skill instructions change', () => {
    const workspace = tempRoot();
    const userRoot = tempRoot();
    const skillPath = join(workspace, '.claude', 'skills', 'review', 'SKILL.md');
    write(skillPath, '---\nname: review\ndescription: Review changes\n---\nRead carefully.');
    const compile = () => compileManagedCodexExtensionSnapshot({
      workspacePath: workspace,
      userConfigRoot: userRoot,
      enabledPluginIds: [],
      scenario: { type: 'desktop' },
      mcpServers: [],
    });
    const first = compile();
    write(skillPath, '---\nname: review\ndescription: Review changes\n---\nRead very carefully.');
    const second = compile();

    expect(first.skills[0]?.contentSha256).not.toBe(second.skills[0]?.contentSha256);
    expect(first.revision).not.toBe(second.revision);
  });

  it('projects only enabled global Skills', () => {
    const workspace = tempRoot();
    const userRoot = tempRoot();
    write(join(userRoot, 'skills', 'enabled', 'SKILL.md'), '---\nname: enabled\ndescription: Enabled Skill\n---\nRun it.');
    write(join(userRoot, 'skills', 'disabled', 'SKILL.md'), '---\nname: disabled\ndescription: Disabled Skill\n---\nDo not run it.');
    write(join(userRoot, 'skills-config.json'), JSON.stringify({ disabled: ['disabled'] }));

    const snapshot = compileManagedCodexExtensionSnapshot({
      workspacePath: workspace,
      userConfigRoot: userRoot,
      enabledPluginIds: [],
      scenario: { type: 'desktop' },
      mcpServers: [],
    });

    expect(snapshot.skills.map(skill => skill.name)).toEqual(['enabled']);
    expect(snapshot.components).toContainEqual(expect.objectContaining({
      component: 'skills',
      id: 'global:disabled',
      state: 'not_applicable',
      code: 'skill_disabled',
    }));
  });

  it('honors trusted plugin manifest component paths without loading replaced defaults', () => {
    const workspace = tempRoot();
    const pluginRoot = tempRoot();
    write(join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'custom-plugin',
      skills: './custom-skills',
      commands: './custom-commands',
      agents: './custom-agents',
      mcpServers: './config/mcp.json',
      hooks: './config/hooks.json',
    }));
    write(join(pluginRoot, 'skills', 'default-skill', 'SKILL.md'), '---\nname: default-skill\ndescription: Default Skill\n---\nDefault.');
    write(join(pluginRoot, 'custom-skills', 'custom-skill', 'SKILL.md'), '---\nname: custom-skill\ndescription: Custom Skill\n---\nCustom.');
    write(join(pluginRoot, 'commands', 'ignored.md'), '---\nname: ignored\n---\nIgnored.');
    write(join(pluginRoot, 'custom-commands', 'ship.md'), '---\nname: ship\n---\nShip it.');
    write(join(pluginRoot, 'agents', 'ignored.md'), '---\nname: ignored-agent\ndescription: Ignored\n---\nIgnored.');
    write(join(pluginRoot, 'custom-agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Review changes\nskills:\n  - custom-skill\n---\nReview.');
    write(join(pluginRoot, 'config', 'mcp.json'), JSON.stringify({
      mcpServers: {
        helper: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'] },
        legacy: { type: 'sse', url: 'https://example.invalid/events' },
      },
    }));
    write(join(pluginRoot, '.lsp.json'), '{}');
    write(join(pluginRoot, 'monitors', 'monitors.json'), '[]');
    write(join(pluginRoot, 'bin', 'server'), '#!/bin/sh');
    pluginStore.entries = [{ id: 'custom-plugin@local', enabled: true, installPath: pluginRoot }];

    const snapshot = compileManagedCodexExtensionSnapshot({
      workspacePath: workspace,
      userConfigRoot: null,
      enabledPluginIds: ['custom-plugin@local'],
      scenario: { type: 'desktop' },
      mcpServers: [],
    });

    expect(snapshot.skills.map(skill => skill.name)).toEqual(['custom-skill', 'default-skill']);
    expect(snapshot.commands.map(command => command.name)).toEqual(['ship']);
    expect(snapshot.agents.map(agent => agent.name)).toEqual(['reviewer']);
    expect(snapshot.mcpServers).toContainEqual(expect.objectContaining({
      id: 'plugin__custom-plugin_local__helper',
      command: 'node',
      args: [join(realpathSync(pluginRoot), 'server.js')],
    }));
    expect(snapshot.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: 'plugins', state: 'unsupported', code: 'plugin_hooks_unsupported' }),
      expect.objectContaining({ component: 'plugins', state: 'unsupported', code: 'plugin_lsp_unsupported' }),
      expect.objectContaining({ component: 'plugins', state: 'unsupported', code: 'plugin_monitors_unsupported' }),
      expect.objectContaining({ component: 'plugins', state: 'unsupported', code: 'plugin_bin_unsupported' }),
      expect.objectContaining({ component: 'mcp', state: 'unsupported', code: 'plugin_mcp_sse_unsupported' }),
    ]));
  });

  it('reports transports that the pinned Codex app-server cannot represent', () => {
    const workspace = tempRoot();
    const snapshot = compileManagedCodexExtensionSnapshot({
      workspacePath: workspace,
      userConfigRoot: null,
      enabledPluginIds: [],
      scenario: { type: 'desktop' },
      mcpServers: [{
        id: 'legacy-events',
        name: 'Legacy SSE',
        type: 'sse',
        url: 'https://example.invalid/events',
        isBuiltin: false,
      }],
    });

    expect(snapshot.mcpServers).toEqual([]);
    expect(snapshot.components).toContainEqual(expect.objectContaining({
      component: 'mcp',
      id: 'legacy-events',
      state: 'unsupported',
      code: 'mcp_transport_unsupported',
    }));
  });

  it.runIf(process.platform !== 'win32')('does not follow symlinked extension roots outside the trusted workspace', () => {
    const workspace = tempRoot();
    const outside = tempRoot();
    write(join(outside, 'escape.md'), [
      '---',
      'name: escape',
      'description: Must not load',
      '---',
      'Read outside the workspace.',
    ].join('\n'));
    mkdirSync(join(workspace, '.claude'), { recursive: true });
    symlinkSync(outside, join(workspace, '.claude', 'commands'));

    const snapshot = compileManagedCodexExtensionSnapshot({
      workspacePath: workspace,
      userConfigRoot: null,
      enabledPluginIds: [],
      mcpServers: [],
      scenario: { type: 'desktop' },
    });
    expect(snapshot.commands).toEqual([]);
    expect(snapshot.components.some(result => result.id?.includes('escape'))).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('does not follow a symlinked Agent workspace config outside the trusted workspace', () => {
    const workspace = tempRoot();
    const outside = tempRoot();
    write(join(workspace, '.claude', 'agents', 'reviewer.md'), [
      '---',
      'name: reviewer',
      'description: Reviews changes',
      '---',
      'Review carefully.',
    ].join('\n'));
    write(join(outside, '_workspace.json'), JSON.stringify({
      local: { reviewer: { enabled: false } },
      global_refs: {},
    }));
    symlinkSync(join(outside, '_workspace.json'), join(workspace, '.claude', 'agents', '_workspace.json'));

    const snapshot = compileManagedCodexExtensionSnapshot({
      workspacePath: workspace,
      userConfigRoot: null,
      enabledPluginIds: [],
      mcpServers: [],
      scenario: { type: 'desktop' },
    });

    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.components).toContainEqual(expect.objectContaining({
      component: 'agents',
      id: 'workspace-config',
      state: 'failed',
      code: 'agent_workspace_config_untrusted',
    }));
  });
});
