import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBuiltinMcpInstance: vi.fn(),
  getImBridgeToolServer: vi.fn(() => null),
}));

vi.mock('../../tools/builtin-mcp-registry', () => ({
  getBuiltinMcpInstance: mocks.getBuiltinMcpInstance,
}));
vi.mock('../../tools/im-bridge-tools', () => ({
  getImBridgeToolServer: mocks.getImBridgeToolServer,
}));

import type { ManagedCodexExtensionSnapshot } from '../managed-codex/extensions/contracts';
import { attachProductHostTools } from './host-dispatcher';

function snapshot(): ManagedCodexExtensionSnapshot {
  return {
    revision: 'revision-one',
    workspacePath: '/workspace',
    scenario: { type: 'desktop' },
    enabledPluginIds: [],
    skills: [],
    commands: [],
    agents: [],
    mcpServers: [{
      id: 'local-tools',
      name: 'Local tools',
      type: 'stdio',
      command: '__builtin__',
      isBuiltin: true,
    }],
    dynamicTools: [],
    components: [],
  };
}

function call(tool: string, args: unknown, generation = 'generation-one') {
  return {
    processGeneration: generation,
    threadId: 'thread-one',
    turnId: 'turn-one',
    callId: `call-${Math.random()}`,
    tool,
    arguments: args,
    signal: new AbortController().signal,
  };
}

describe('Managed Codex Host tool dispatcher', () => {
  it('keeps overlapping replacement dispatchers connected until the last owner releases', async () => {
    const server = new McpServer({ name: 'local-tools', version: '1.0.0' });
    server.registerTool('echo', { inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    mocks.getBuiltinMcpInstance.mockReturnValue(Promise.resolve({ server: { type: 'sdk', name: 'local-tools', instance: server } }));
    const attach = () => attachProductHostTools({ snapshot: snapshot(), sessionId: 'session-one', workspacePath: '/workspace' });
    const [first, second] = await Promise.all([attach(), attach()]);
    expect(first.dynamicTools).toHaveLength(1);
    expect(second.dynamicTools).toEqual(first.dynamicTools);
    await expect(first.hostToolDispatcher!.dispatch(call(first.dynamicTools[0]!.name, {}))).resolves.toMatchObject({ success: true });
    first.hostToolDispatcher!.dispose('replacement accepted');
    first.hostToolDispatcher!.dispose('duplicate disposal');
    await expect(second.hostToolDispatcher!.dispatch(call(second.dynamicTools[0]!.name, {}, 'generation-two'))).resolves.toMatchObject({ success: true });
    second.hostToolDispatcher!.dispose('end');
    const third = await attach();
    await expect(third.hostToolDispatcher!.dispatch(call(third.dynamicTools[0]!.name, {}, 'generation-three'))).resolves.toMatchObject({ success: true });
    third.hostToolDispatcher!.dispose('end');
  });

  it('discovers, validates, dispatches, and reconnects a cached in-process MCP server', async () => {
    const server = new McpServer({ name: 'local-tools', version: '1.0.0' });
    server.registerTool(
      'echo',
      {
        description: 'Echo a value',
        inputSchema: { value: z.string() },
      },
      async ({ value }) => ({ content: [{ type: 'text', text: `echo:${value}` }] }),
    );
    mocks.getBuiltinMcpInstance.mockReturnValue(Promise.resolve({
      server: { type: 'sdk', name: 'local-tools', instance: server },
    }));

    const first = await attachProductHostTools({
      snapshot: snapshot(),
      sessionId: 'session-one',
      workspacePath: '/workspace',
    });
    expect(first.dynamicTools).toEqual([expect.objectContaining({
      name: 'myagents__mcp__local-tools__echo',
      description: 'Echo a value',
    })]);
    expect(first.dynamicTools[0]?.name).not.toMatch(/^mcp(?:__|$)/);
    expect(first.dynamicTools[0]?.name).toMatch(/^[A-Za-z0-9_-]+$/);
    await expect(first.hostToolDispatcher!.dispatch(
      call('myagents__mcp__local-tools__echo', { value: 'hello' }),
    )).resolves.toEqual({
      success: true,
      contentItems: [{ type: 'text', text: 'echo:hello' }],
    });
    await expect(first.hostToolDispatcher!.dispatch(
      call('myagents__mcp__local-tools__echo', { value: 42 }),
    )).resolves.toMatchObject({ success: false });

    first.hostToolDispatcher!.dispose('process generation ended');
    const second = await attachProductHostTools({
      snapshot: snapshot(),
      sessionId: 'session-one',
      workspacePath: '/workspace',
    });
    await expect(second.hostToolDispatcher!.dispatch(
      call('myagents__mcp__local-tools__echo', { value: 'again' }, 'generation-two'),
    )).resolves.toMatchObject({
      success: true,
      contentItems: [{ type: 'text', text: 'echo:again' }],
    });
    second.hostToolDispatcher!.dispose('test complete');
  });


  it('does not close an existing transport it failed to acquire', async () => {
    const server = new McpServer({ name: 'owned-elsewhere', version: '1.0.0' });
    server.registerTool('echo', { inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'other-owner', version: '1.0.0' });
    await server.connect(a); await client.connect(b);
    mocks.getBuiltinMcpInstance.mockReturnValue(Promise.resolve({ server: { type: 'sdk', name: 'owned-elsewhere', instance: server } }));
    const rejected = await attachProductHostTools({ snapshot: snapshot(), sessionId: 'session-one', workspacePath: '/workspace' });
    expect(rejected.dynamicTools).toEqual([]);
    expect((await client.listTools()).tools).toHaveLength(1);
    await client.close(); await server.close();
  });

  it('rejects stale process generations before invoking the handler', async () => {
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    const server = new McpServer({ name: 'local-tools', version: '1.0.0' });
    server.registerTool('once', { inputSchema: {} }, handler);
    mocks.getBuiltinMcpInstance.mockReturnValue(Promise.resolve({
      server: { type: 'sdk', name: 'local-tools', instance: server },
    }));
    const attached = await attachProductHostTools({
      snapshot: snapshot(),
      sessionId: 'session-one',
      workspacePath: '/workspace',
    });

    await attached.hostToolDispatcher!.dispatch(call('myagents__mcp__local-tools__once', {}));
    await expect(attached.hostToolDispatcher!.dispatch(
      call('myagents__mcp__local-tools__once', {}, 'stale-generation'),
    )).rejects.toThrow(/stale/i);
    expect(handler).toHaveBeenCalledOnce();
    attached.hostToolDispatcher!.dispose('test complete');
  });

  it('rejects a server when distinct native names collapse to one Codex wire name', async () => {
    const server = new McpServer({ name: 'local-tools', version: '1.0.0' });
    server.registerTool('echo.tool', { inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: 'dot' }],
    }));
    server.registerTool('echo_tool', { inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: 'underscore' }],
    }));
    mocks.getBuiltinMcpInstance.mockReturnValue(Promise.resolve({
      server: { type: 'sdk', name: 'local-tools', instance: server },
    }));

    const attached = await attachProductHostTools({
      snapshot: snapshot(),
      sessionId: 'session-one',
      workspacePath: '/workspace',
    });

    expect(attached.dynamicTools).toEqual([]);
    expect(attached.hostToolDispatcher).toBeUndefined();
    expect(attached.components).toContainEqual(expect.objectContaining({
      component: 'host_tools',
      id: 'local-tools',
      state: 'failed',
      code: 'host_tool_name_conflict',
    }));
  });
});
