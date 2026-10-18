import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Proxy declarative plugin schemas without translating them through Zod.
 * The same MCP instance serves builtin SDK and Product host-tool dispatchers. */
export async function createImBridgeMcpServer(
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
  call: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<CallToolResult>,
): Promise<McpSdkServerConfigWithInstance> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { CallToolRequestSchema, ListToolsRequestSchema, ToolSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/sdk/validation/ajv');
  const instance = new McpServer({ name: 'im-bridge-tools', version: '1.0.0' });
  const admitted = new Map<string, {
    descriptor: ReturnType<typeof ToolSchema.parse>;
    validate: ReturnType<InstanceType<typeof AjvJsonSchemaValidator>['getValidator']>;
  }>();
  for (const tool of tools) {
    try {
      if (admitted.has(tool.name)) throw new Error('Duplicate plugin tool');
      const descriptor = ToolSchema.parse({ name: tool.name, description: tool.description, inputSchema: tool.parameters });
      // A validator per tool keeps plugin-local $id definitions isolated.
      const validate = new AjvJsonSchemaValidator().getValidator(descriptor.inputSchema);
      admitted.set(tool.name, { descriptor, validate });
    } catch {
      console.warn(`[im-bridge-tools] Invalid plugin tool schema: ${tool.name}`);
    }
  }
  instance.server.registerCapabilities({ tools: {} });
  instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...admitted.values()].map(entry => entry.descriptor),
  }));
  instance.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const entry = admitted.get(request.params.name);
    if (!entry) return { isError: true, content: [{ type: 'text', text: 'Unknown plugin tool' }] };
    const args = request.params.arguments ?? {};
    if (!entry.validate(args).valid) {
      return { isError: true, content: [{ type: 'text', text: 'Arguments do not match the plugin tool input schema' }] };
    }
    if (extra.signal.aborted) throw new Error('Plugin tool call cancelled');
    return call(request.params.name, args, extra.signal);
  });
  return { type: 'sdk', name: 'im-bridge-tools', instance };
}
