import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createImBridgeMcpServer } from '../tools/im-bridge/mcp-server';
import { compileDshProductExtensionPlane, normalizeDshHostToolInputSchema } from '../integrated-runtimes/dsh/extension-compiler';
import { clearImBridgeToolsContext, ensureImBridgeToolSurface, getImBridgeToolServer } from '../tools/im-bridge-tools';

const bridgeFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/cancellation', () => ({ cancellableFetch: bridgeFetch }));

const schema = {
  type: 'object', properties: { args: { type: 'array', items: { type: 'string' } } },
  required: ['args'], additionalProperties: false,
};
const close: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(close.splice(0).map(fn => fn())); clearImBridgeToolsContext(); });
async function connect(parameters = schema) {
  const call = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
  const server = await createImBridgeMcpServer([{ name: 'wecom-cli', description: 'WeCom', parameters }], call);
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(a);
  await client.connect(b);
  close.push(() => client.close(), () => server.instance.close());
  return { client, call };
}

describe('plugin declarative MCP surface', () => {
  it('retains the discovered Bridge schema through the real Session surface', async () => {
    bridgeFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, tools: [
      { name: 'wecom-cli', description: 'WeCom', group: 'default', parameters: schema },
    ] }), { headers: { 'Content-Type': 'application/json' } }));
    await ensureImBridgeToolSurface({ bridgePort: 12345, pluginId: 'wecom', enabledToolGroups: ['default'] }, () => ({ senderId: 'user' }));
    const server = getImBridgeToolServer()!;
    const client = new Client({ name: 'session-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(a);
    await client.connect(b);
    close.push(() => client.close(), () => server.instance.close());
    expect((await client.listTools()).tools[0]?.inputSchema).toEqual(schema);
  });

  it('preserves real listTools schema through DSH compilation and forwards native args without a wrapper', async () => {
    const { client, call } = await connect();
    const listed = await client.listTools();
    expect(listed.tools[0]?.inputSchema).toEqual(schema);
    const plane = compileDshProductExtensionPlane({ revision: 'a'.repeat(64), skills: [], commands: [], agents: [], mcpServers: [],
      dynamicTools: listed.tools.map(tool => ({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema })),
      hostToolDispatcher: { descriptors: [], dispatch: vi.fn(), dispose: vi.fn() },
    });
    expect(plane.diagnostics).toContainEqual(expect.objectContaining({ id: 'wecom-cli', code: 'dsh_host_tool_compiled' }));
    expect(plane.hostToolBindings).toHaveLength(1);
    await client.callTool({ name: 'wecom-cli', arguments: { args: ['message', 'aibot', 'sessions', 'list'] } });
    expect(call).toHaveBeenCalledWith('wecom-cli', { args: ['message', 'aibot', 'sessions', 'list'] }, expect.any(AbortSignal));
  });

  it('rejects missing, wrong-type, and unknown arguments before executing the plugin', async () => {
    const { client, call } = await connect();
    for (const args of [{}, { args: 'identity whoami' }, { args: ['identity'], unwanted: true }, { args: { args: ['identity'] } }]) {
      expect(await client.callTool({ name: 'wecom-cli', arguments: args })).toMatchObject({ isError: true });
    }
    expect(call).not.toHaveBeenCalled();
  });

  it('accepts standard root dialect metadata without dropping semantic constraints', () => {
    expect(normalizeDshHostToolInputSchema({ ...schema, $schema: 'http://json-schema.org/draft-07/schema#' })).toEqual(schema);
    expect(() => normalizeDshHostToolInputSchema({ ...schema, $schema: 'https://unknown.invalid' })).toThrow();
    expect(() => normalizeDshHostToolInputSchema({ ...schema, additionalProperties: {} })).toThrow();
    expect(() => normalizeDshHostToolInputSchema({ ...schema, properties: { args: { type: 'object', propertyNames: { type: 'string' } } } })).toThrow();
  });
});
