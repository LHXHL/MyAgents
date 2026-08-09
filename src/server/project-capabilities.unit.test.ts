import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { REQUIRED_SYSTEM_SKILLS } from '../shared/systemSkills';

import {
  resolveEffectiveProjectCapabilities,
  setProjectCapabilityEnabled,
} from './project-capabilities';

const roots: string[] = [];

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function skill(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\nRun it.\n`;
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'myagents-project-capability-'));
  roots.push(root);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('TMPDIR', join(root, 'tmp'));
  vi.stubEnv('TEMP', join(root, 'tmp'));
  vi.stubEnv('TMP', join(root, 'tmp'));
  write(join(home, '.myagents', 'config.json'), JSON.stringify({
    agents: [{ id: 'agent-1', path: workspace }],
  }));
  write(join(home, '.myagents', 'projects.json'), JSON.stringify([
    { id: 'project-1', path: workspace, agentId: 'agent-1' },
  ]));
  for (const name of REQUIRED_SYSTEM_SKILLS) {
    write(join(home, '.myagents', 'skills', name, 'SKILL.md'), skill(name, 'required'));
  }
  return { home, workspace };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('effective project capabilities', () => {
  it('defaults candidates on, resolves project before global, and disables the winner without fallback', async () => {
    const { home, workspace } = makeFixture();
    write(join(home, '.myagents', 'skills', 'global-review', 'SKILL.md'), skill('review', 'global'));
    write(join(workspace, '.claude', 'skills', 'local-review', 'SKILL.md'), skill('review', 'project'));
    write(join(home, '.myagents', 'commands', 'ship.md'), '---\nname: ship\n---\nGlobal ship.\n');

    const initial = resolveEffectiveProjectCapabilities(workspace);
    const review = initial.candidates.find(item => item.canonicalName === 'review');
    expect(review).toMatchObject({
      id: 'project:skill:local-review',
      source: 'project',
      enabled: true,
    });
    expect(initial.candidates.filter(item => item.canonicalName === 'review')).toHaveLength(1);

    const updated = await setProjectCapabilityEnabled({
      workspacePath: workspace,
      capabilityId: 'project:skill:local-review',
      enabled: false,
    });
    expect(updated.candidates.filter(item => item.canonicalName === 'review')).toEqual([
      expect.objectContaining({ id: 'project:skill:local-review', enabled: false }),
    ]);
    expect(updated.enabledSkills.some(item => item.canonicalName === 'review')).toBe(false);

    const config = JSON.parse(readFileSync(join(home, '.myagents', 'config.json'), 'utf8'));
    expect(config.agents[0].capabilitySelection.disabled.skills).toEqual([
      'project:skill:local-review',
    ]);
  });

  it('keeps required system Skills enabled and rejects disabling them', async () => {
    const { home, workspace } = makeFixture();
    write(join(home, '.myagents', 'skills', 'myagents-cli', 'SKILL.md'), skill('myagents-cli', 'required'));

    const snapshot = resolveEffectiveProjectCapabilities(workspace);
    expect(snapshot.enabledSkills).toContainEqual(expect.objectContaining({
      id: 'global:skill:myagents-cli',
      required: true,
    }));
    await expect(setProjectCapabilityEnabled({
      workspacePath: workspace,
      capabilityId: 'global:skill:myagents-cli',
      enabled: false,
    })).rejects.toThrow('Required system Skill cannot be disabled');
  });

  it('fails closed without an exact owner and rejects project Required-Skill spoofing', () => {
    const { home, workspace } = makeFixture();
    write(join(home, '.myagents', 'projects.json'), JSON.stringify([]));
    expect(() => resolveEffectiveProjectCapabilities(workspace)).toThrow('unique Project owner');

    write(join(home, '.myagents', 'projects.json'), JSON.stringify([
      { id: 'project-1', path: workspace, agentId: 'agent-1' },
    ]));
    write(
      join(workspace, '.claude', 'skills', 'local-spoof', 'SKILL.md'),
      skill('myagents-cli', 'not system owned'),
    );
    expect(() => resolveEffectiveProjectCapabilities(workspace)).toThrow(
      'collides with required system Skill',
    );
  });

  it('rejects an AgentConfig claimed by more than one Project', () => {
    const { home, workspace } = makeFixture();
    const secondWorkspace = join(home, 'second-workspace');
    mkdirSync(secondWorkspace, { recursive: true });
    write(join(home, '.myagents', 'projects.json'), JSON.stringify([
      { id: 'project-1', path: workspace, agentId: 'agent-1' },
      { id: 'project-2', path: secondWorkspace, agentId: 'agent-1' },
    ]));
    expect(() => resolveEffectiveProjectCapabilities(workspace)).toThrow(
      'claimed by multiple Projects',
    );
  });

  it('rejects a global Skill that aliases a required system identity', () => {
    const { home, workspace } = makeFixture();
    write(
      join(home, '.myagents', 'skills', 'not-system-owned', 'SKILL.md'),
      skill('myagents-cli', 'not the official install'),
    );
    expect(() => resolveEffectiveProjectCapabilities(workspace)).toThrow(
      'not-system-owned:untrusted_global_source',
    );
  });

  it('keeps reserved product command names outside project selection', () => {
    const { workspace } = makeFixture();
    write(join(workspace, '.claude', 'commands', 'custom.md'), '---\nname: compact\n---\nCustom compact.\n');
    write(join(workspace, '.claude', 'commands', 'goal.md'), '---\nname: goal\n---\nCustom goal.\n');
    write(join(workspace, '.claude', 'commands', 'invalid.md'), '---\nname: invalid name\n---\nInvalid.\n');
    expect(resolveEffectiveProjectCapabilities(workspace).candidates).not.toContainEqual(
      expect.objectContaining({ kind: 'command', canonicalName: 'compact' }),
    );
    expect(resolveEffectiveProjectCapabilities(workspace).candidates).not.toContainEqual(
      expect.objectContaining({ kind: 'command', canonicalName: 'invalid name' }),
    );
    expect(resolveEffectiveProjectCapabilities(workspace).candidates).not.toContainEqual(
      expect.objectContaining({ kind: 'command', canonicalName: 'goal' }),
    );
  });

  it('treats a real project entry as the owner of its physical projection slot', () => {
    const { home, workspace } = makeFixture();
    write(join(home, '.myagents', 'skills', 'shared-slot', 'SKILL.md'), skill('global-name', 'global'));
    write(join(workspace, '.claude', 'skills', 'shared-slot', 'SKILL.md'), skill('project-name', 'project'));

    const snapshot = resolveEffectiveProjectCapabilities(workspace);
    expect(snapshot.candidates).toContainEqual(expect.objectContaining({
      id: 'project:skill:shared-slot',
      canonicalName: 'project-name',
    }));
    expect(snapshot.candidates).not.toContainEqual(expect.objectContaining({
      id: 'global:skill:shared-slot',
    }));
  });

  it('keeps invalid real project entries in control of their physical slots', () => {
    const { home, workspace } = makeFixture();
    write(join(home, '.myagents', 'skills', 'occupied-skill', 'SKILL.md'), skill('global-skill', 'global'));
    mkdirSync(join(workspace, '.claude', 'skills', 'occupied-skill'), { recursive: true });
    write(join(home, '.myagents', 'commands', 'occupied-command.md'), 'Global command.\n');
    write(join(workspace, '.claude', 'commands', 'occupied-command.md'), '---\nname: local\n---\n');

    const snapshot = resolveEffectiveProjectCapabilities(workspace);

    expect(snapshot.candidates).not.toContainEqual(expect.objectContaining({
      id: 'global:skill:occupied-skill',
    }));
    expect(snapshot.candidates).not.toContainEqual(expect.objectContaining({
      id: 'global:command:occupied-command',
    }));
  });

  it('rejects global Skill and Command symlinks inside or outside their capability roots', () => {
    const { home, workspace } = makeFixture();
    const outsideSkill = join(home, 'outside', 'skill');
    const outsideCommand = join(home, 'outside', 'command.md');
    write(join(outsideSkill, 'SKILL.md'), skill('outside-skill', 'outside'));
    write(outsideCommand, 'Outside command.\n');
    const globalSkills = join(home, '.myagents', 'skills');
    const globalCommands = join(home, '.myagents', 'commands');
    write(join(globalSkills, 'real-skill', 'SKILL.md'), skill('real-skill', 'real'));
    write(join(globalCommands, 'real-command.md'), 'Real command.\n');
    symlinkSync(outsideSkill, join(globalSkills, 'outside-skill'));
    symlinkSync(outsideCommand, join(globalCommands, 'outside-command.md'));
    symlinkSync(join(globalSkills, 'real-skill'), join(globalSkills, 'alias-skill'));
    symlinkSync(join(globalCommands, 'real-command.md'), join(globalCommands, 'alias-command.md'));

    const snapshot = resolveEffectiveProjectCapabilities(workspace);

    expect(snapshot.candidates).not.toContainEqual(expect.objectContaining({
      id: 'global:skill:outside-skill',
    }));
    expect(snapshot.candidates).not.toContainEqual(expect.objectContaining({
      id: 'global:command:outside-command',
    }));
    expect(snapshot.candidates).not.toContainEqual(expect.objectContaining({
      id: 'global:skill:alias-skill',
    }));
    expect(snapshot.candidates).not.toContainEqual(expect.objectContaining({
      id: 'global:command:alias-command',
    }));
  });
});
