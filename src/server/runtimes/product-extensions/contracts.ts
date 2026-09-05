import type { SkillFrontmatter } from '../../../shared/slashCommands';
import type { InteractionScenario } from '../../system-prompt';
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

export interface ProductCommandSpec {
  name: string;
  description: string;
  body: string;
  scope: 'project' | 'user' | 'plugin';
  sourceId: string;
  sourceLocalId?: string;
}

export interface ProductSkillSpec {
  /** Exact metadata from the admitted source bytes; Runtime admission owns its semantics. */
  frontmatter?: Readonly<Partial<SkillFrontmatter>>;
  name: string;
  description: string;
  /** Digest of the trusted SKILL.md contents; never the user-authored body. */
  contentSha256: string;
  path: string;
  scope: 'project' | 'user' | 'plugin';
  sourceId: string;
  sourceLocalId?: string;
}

export interface ProductAgentRoleSpec {
  name: string;
  description: string;
  prompt: string;
  model?: string;
  /** Runtime-specific visible tool allowlist. Omitted means inherit the eligible parent catalog. */
  tools?: string[];
  /** Tools removed after inheritance/allowlist resolution. */
  disallowedTools?: string[];
  maxTurns?: number;
  skills: Array<{ name: string; path: string }>;
  scope: 'project' | 'user' | 'plugin';
  sourceId: string;
}


export interface ProductExtensionSnapshot {
  revision: string;
  workspacePath: string;
  scenario: InteractionScenario;
  enabledPluginIds: string[];
  skills: ProductSkillSpec[];
  commands: ProductCommandSpec[];
  agents: ProductAgentRoleSpec[];
  mcpServers: McpServerDefinition[];
  dynamicTools: ProductDynamicToolSpec[];
  hostToolDispatcher?: ProductHostToolDispatcher;
  components: ProductExtensionComponentResult[];
}

export interface ProductCommandExpansion {
  commandName: string;
  rawText: string;
  runtimeText: string;
  revision: string;
}
