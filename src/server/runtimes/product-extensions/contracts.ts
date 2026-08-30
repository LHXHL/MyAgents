import type { McpServerDefinition } from '../../../shared/config-types';

export type ProductExtensionApplyState =
  | 'unchanged'
  | 'applied'
  | 'pending_next_start'
  | 'deferred_until_idle'
  | 'not_applicable'
  | 'unsupported'
  | 'failed';

export type ProductExtensionComponentKind =
  | 'scenario'
  | 'skills'
  | 'commands'
  | 'agents'
  | 'mcp'
  | 'plugins'
  | 'host_tools';

export interface ProductExtensionComponentResult {
  component: ProductExtensionComponentKind;
  id?: string;
  state: ProductExtensionApplyState;
  code: string;
  message?: string;
  requiresUserAction?: boolean;
}

export interface ProductDynamicToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ProductHostToolCall {
  processGeneration: string;
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments: unknown;
  signal: AbortSignal;
}

export type ProductHostToolContentItem =
  | { type: 'text'; text: string }
  | { type: 'image'; dataUrl: string }
  | { type: 'audio'; dataUrl: string };

export interface ProductHostToolResult {
  success: boolean;
  contentItems: ProductHostToolContentItem[];
}

export interface ProductHostToolDispatcher {
  readonly descriptors: readonly ProductDynamicToolSpec[];
  dispatch(call: ProductHostToolCall): Promise<ProductHostToolResult>;
  dispose(reason: string): void;
}

export interface ProductHostToolInventory {
  mcpServers: McpServerDefinition[];
  dynamicTools: ProductDynamicToolSpec[];
  hostToolDispatcher?: ProductHostToolDispatcher;
  components: ProductExtensionComponentResult[];
}
