import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { DshProductExtensionSource } from './extension-compiler';
import {
  compileDshExtensionSnapshot,
  compileDshProductExtensionPlane,
  findDshHostToolBinding,
  findDshMcpCredentialBinding,
  normalizeDshHostToolInputSchema,
} from './extension-compiler';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function source(overrides: Partial<DshProductExtensionSource> = {}): DshProductExtensionSource {
  return {
    revision: 'a'.repeat(64),
    skills: [],
    commands: [],
    agents: [],
    mcpServers: [],
    dynamicTools: [],
    ...overrides,
  };
}

describe('DSH declarative extension compiler', () => {
  it('keeps the empty snapshot deterministic and immutable', () => {
    const first = compileDshExtensionSnapshot();
    const second = compileDshExtensionSnapshot();

    expect(first).toEqual(second);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.skillSourcePolicy)).toBe(true);
  });

  it('projects Product Skills, commands, agents, remote MCP, and Host tools without secrets', () => {
    const root = mkdtempSync(join(tmpdir(), 'myagents-dsh-extension-'));
    const skillPath = join(root, 'SKILL.md');
    const skillContent = '---\nname: review\ndescription: Review changes\n---\n\n# Review\n';
    writeFileSync(skillPath, skillContent, 'utf8');
    const dispatcher = {
      descriptors: [],
      dispatch: vi.fn(),
      dispose: vi.fn(),
    };
    const plane = compileDshProductExtensionPlane(source({
      skills: [{
        name: 'review',
        description: 'Review changes',
        contentSha256: sha256(skillContent),
        path: skillPath,
        scope: 'project',
        sourceId: 'workspace',
      }],
      commands: [{
        name: 'verify',
        description: 'Verify the change',
        body: 'Run the relevant checks.',
        scope: 'project',
        sourceId: 'workspace',
      }],
      agents: [{
        name: 'reviewer',
        description: 'Reviews a change',
        prompt: 'Review the change carefully.',
        skills: [{ name: 'review', path: skillPath }],
        scope: 'project',
        sourceId: 'workspace',
      }],
      mcpServers: [
        {
          id: 'remote-tools',
          name: 'Remote tools',
          type: 'http',
          url: 'https://example.test/mcp',
          headers: { authorization: 'Bearer private-token' },
          runtimeConfigRevision: 'remote-tools-credentials-v1',
          isBuiltin: false,
        },
        {
          id: 'local-tools',
          name: 'Local tools',
          type: 'stdio',
          command: 'node',
          isBuiltin: false,
        },
      ],
      dynamicTools: [{
        name: 'myagents__mcp__builtin__lookup',
        description: 'Looks up Product data',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
      }],
      hostToolDispatcher: dispatcher,
    }));

    expect(plane.snapshot.components.map(component => component.kind)).toEqual([
      'skill',
      'command',
      'agent',
      'mcp',
      'host_tool',
    ]);
    expect(plane.snapshot.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'skill_document', content: skillContent }),
      expect.objectContaining({ kind: 'command_template', content: 'Run the relevant checks.' }),
    ]));
    expect(JSON.stringify(plane.snapshot)).not.toContain('private-token');
    expect(plane.credentialBindings).toEqual([
      expect.objectContaining({
        componentId: 'remote-tools',
        credentialRevision: 'remote-tools-credentials-v1',
        material: { authorization: 'Bearer private-token' },
      }),
    ]);
    const credential = plane.credentialBindings[0]!;
    expect(findDshMcpCredentialBinding(plane, {
      componentId: credential.componentId,
      credentialRef: credential.credentialRef,
      credentialRevision: credential.credentialRevision,
      materialSlot: credential.materialSlot,
    })).toBe(credential);
    const hostTool = plane.hostToolBindings[0]!;
    expect(findDshHostToolBinding(plane, hostTool.publicToolName)).toBe(hostTool);
    expect(hostTool.publicToolName).toBe(
      'mcp__myagents_host__myagents__mcp__builtin__lookup',
    );
    expect(plane.expectedSkillNames).toEqual(['review']);
    expect(plane.diagnostics).toContainEqual(expect.objectContaining({
      id: 'local-tools',
      state: 'unsupported',
      code: 'dsh_stdio_launch_profile_unavailable',
    }));
  });

  it('fails a changed Skill and degrades unsafe per-component inputs', () => {
    const root = mkdtempSync(join(tmpdir(), 'myagents-dsh-extension-drift-'));
    const skillPath = join(root, 'SKILL.md');
    writeFileSync(skillPath, '# Changed\n', 'utf8');

    expect(() => compileDshProductExtensionPlane(source({
      skills: [{
        name: 'review',
        description: 'Review',
        contentSha256: sha256('# Original\n'),
        path: skillPath,
        scope: 'project',
        sourceId: 'workspace',
      }],
    }))).toThrow(/changed after Product capability admission/u);

    const degraded = compileDshProductExtensionPlane(source({
      mcpServers: [{
        id: 'credential-without-revision',
        name: 'Credential MCP',
        type: 'http',
        url: 'https://example.test/mcp',
        headers: { authorization: 'secret' },
        isBuiltin: false,
      }],
      dynamicTools: [{
        name: 'unsupported_schema',
        description: 'Uses an unsupported schema keyword',
        inputSchema: { type: 'object', patternProperties: {} },
      }],
      hostToolDispatcher: { descriptors: [], dispatch: vi.fn(), dispose: vi.fn() },
    }));
    expect(degraded.snapshot.components).toEqual([]);
    expect(degraded.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'dsh_mcp_credential_revision_missing', state: 'unsupported' }),
      expect.objectContaining({ code: 'dsh_host_tool_schema_invalid', state: 'failed' }),
    ]));
  });

  it('normalizes only the protocol closed JSON Schema subset', () => {
    expect(normalizeDshHostToolInputSchema({
      type: 'object',
      properties: { count: { type: 'integer', enum: [1, 2] } },
      required: ['count'],
    })).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { count: { type: 'integer', enum: [1, 2] } },
      required: ['count'],
    });
    expect(() => normalizeDshHostToolInputSchema({
      type: 'object',
      oneOf: [],
    })).toThrow(/unsupported JSON Schema keywords/u);
    expect(() => normalizeDshHostToolInputSchema({
      type: 'object',
      properties: { query: { type: 'string', minLength: 1 } },
    })).toThrow(/unsupported JSON Schema keywords/u);
  });

  it('degrades a Host tool whose rendered public identity exceeds the Runtime name bound', () => {
    const toolName = 'a'.repeat(45);
    const plane = compileDshProductExtensionPlane(source({
      dynamicTools: [{
        name: toolName,
        description: 'Too long after the fixed public prefix',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      }],
      hostToolDispatcher: {
        descriptors: [],
        dispatch: vi.fn(),
        dispose: vi.fn(),
      },
    }));

    expect(plane.snapshot.components).toEqual([]);
    expect(plane.hostToolBindings).toEqual([]);
    expect(plane.diagnostics).toContainEqual(expect.objectContaining({
      component: 'host_tools',
      id: toolName,
      state: 'failed',
      code: 'dsh_host_tool_name_invalid',
    }));
  });

  it('degrades Product names outside each exact DSH component intersection', () => {
    const root = mkdtempSync(join(tmpdir(), 'myagents-dsh-extension-names-'));
    const skillPath = join(root, 'SKILL.md');
    const skillContent = '# Localized Skill\n';
    writeFileSync(skillPath, skillContent, 'utf8');
    const plane = compileDshProductExtensionPlane(source({
      skills: [{
        name: '中文技能',
        description: 'Valid Product Skill with a DSH-incompatible identity',
        contentSha256: sha256(skillContent),
        path: skillPath,
        scope: 'project',
        sourceId: 'workspace',
      }],
      commands: [{
        name: '中文总结',
        description: 'Valid Product slash command with a DSH-incompatible identity',
        body: 'Summarize.',
        scope: 'project',
        sourceId: 'workspace',
      }],
      mcpServers: [{
        id: 'remote.tools',
        name: 'Remote tools',
        type: 'http',
        url: 'https://example.test/mcp',
        isBuiltin: false,
      }],
    }));

    expect(plane.snapshot.components).toEqual([]);
    expect(plane.snapshot.resources).toEqual([]);
    expect(plane.expectedSkillNames).toEqual([]);
    expect(plane.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'dsh_skill_name_invalid', state: 'failed' }),
      expect.objectContaining({ code: 'dsh_command_name_unsupported', state: 'unsupported' }),
      expect.objectContaining({ code: 'dsh_mcp_name_invalid', state: 'failed' }),
    ]));
  });
});
