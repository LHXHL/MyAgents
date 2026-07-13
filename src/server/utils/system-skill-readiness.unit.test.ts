import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SYSTEM_SKILLS_VERSION } from '../../shared/systemSkills';
import { assertOfficialSystemSkillExposed } from './system-skill-readiness';

function withTempDir<T>(prefix: string, run: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function setup(root: string, exposed: 'official' | 'shadow' | 'wrong' = 'official'): {
  myagentsRoot: string;
  workspacePath: string;
} {
  const myagentsRoot = join(root, '.myagents');
  const workspacePath = join(root, 'workspace');
  const officialDir = join(myagentsRoot, 'skills', 'myagents-memory-update');
  const projectSkills = join(workspacePath, '.claude', 'skills');
  mkdirSync(officialDir, { recursive: true });
  mkdirSync(projectSkills, { recursive: true });
  writeFileSync(join(myagentsRoot, '.system-skills-version'), SYSTEM_SKILLS_VERSION);
  writeFileSync(join(officialDir, 'SKILL.md'), 'official');

  const exposedDir = join(projectSkills, 'myagents-memory-update');
  if (exposed === 'shadow') {
    mkdirSync(exposedDir);
    writeFileSync(join(exposedDir, 'SKILL.md'), 'shadow');
  } else {
    const target = exposed === 'official'
      ? officialDir
      : join(root, 'wrong-skill');
    if (exposed === 'wrong') {
      mkdirSync(target);
      writeFileSync(join(target, 'SKILL.md'), 'wrong');
    }
    symlinkSync(target, exposedDir, process.platform === 'win32' ? 'junction' : 'dir');
  }
  return { myagentsRoot, workspacePath };
}

describe('assertOfficialSystemSkillExposed', () => {
  it('accepts an exact workspace link to the current official install', () => withTempDir('system-skill-ready', (root) => {
    const fixture = setup(root);
    expect(() => assertOfficialSystemSkillExposed({
      ...fixture,
      skillName: 'myagents-memory-update',
    })).not.toThrow();
  }));

  it('rejects a real project directory shadowing the official skill', () => withTempDir('system-skill-shadow', (root) => {
    const fixture = setup(root, 'shadow');
    expect(() => assertOfficialSystemSkillExposed({
      ...fixture,
      skillName: 'myagents-memory-update',
    })).toThrow(/project-owned shadow/);
  }));

  it('rejects a workspace link to a non-official target', () => withTempDir('system-skill-wrong', (root) => {
    const fixture = setup(root, 'wrong');
    expect(() => assertOfficialSystemSkillExposed({
      ...fixture,
      skillName: 'myagents-memory-update',
    })).toThrow(/does not resolve to the official install/);
  }));

  it('rejects a stale global system-skill version', () => withTempDir('system-skill-version', (root) => {
    const fixture = setup(root);
    writeFileSync(join(fixture.myagentsRoot, '.system-skills-version'), '32');
    expect(() => assertOfficialSystemSkillExposed({
      ...fixture,
      skillName: 'myagents-memory-update',
    })).toThrow(/is not current/);
  }));
});
