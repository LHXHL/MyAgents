import type { McpServerDefinition } from '../../../../shared/config-types';
import type { InteractionScenario } from '../../../system-prompt';
import type {
  ProductDynamicToolSpec,
  ProductExtensionApplyState,
  ProductExtensionComponentKind,
  ProductExtensionComponentResult,
  ProductHostToolCall,
  ProductHostToolContentItem,
  ProductHostToolDispatcher,
  ProductHostToolResult,
} from '../../product-extensions/contracts';

export type ManagedCodexExtensionApplyState = ProductExtensionApplyState;

export type ManagedCodexExtensionComponentKind = ProductExtensionComponentKind;

export type ManagedCodexExtensionComponentResult = ProductExtensionComponentResult;

export interface ManagedCodexExtensionStatus {
  desiredRevision: string;
  effectiveRevision: string | null;
  state: ManagedCodexExtensionApplyState;
  components: ManagedCodexExtensionComponentResult[];
}

export interface ManagedCodexExtensionUpdateResult {
  success: boolean;
  extensionStatus: ManagedCodexExtensionStatus;
  error?: string;
}

export interface ManagedCodexCommandSpec {
  name: string;
  description: string;
  body: string;
  scope: 'project' | 'user' | 'plugin';
  sourceId: string;
  sourceLocalId?: string;
}

export interface ManagedCodexSkillSpec {
  name: string;
  description: string;
  /** Digest of the trusted SKILL.md contents; never the user-authored body. */
  contentSha256: string;
  path: string;
  scope: 'project' | 'user' | 'plugin';
  sourceId: string;
  sourceLocalId?: string;
}

export interface ManagedCodexAgentRoleSpec {
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

export type ManagedCodexDynamicToolSpec = ProductDynamicToolSpec;
export type ManagedCodexHostToolCall = ProductHostToolCall;
export type ManagedCodexHostToolContentItem = ProductHostToolContentItem;
export type ManagedCodexHostToolResult = ProductHostToolResult;
export type ManagedCodexHostToolDispatcher = ProductHostToolDispatcher;

export interface ManagedCodexExtensionSnapshot {
  revision: string;
  workspacePath: string;
  scenario: InteractionScenario;
  enabledPluginIds: string[];
  skills: ManagedCodexSkillSpec[];
  commands: ManagedCodexCommandSpec[];
  agents: ManagedCodexAgentRoleSpec[];
  mcpServers: McpServerDefinition[];
  dynamicTools: ManagedCodexDynamicToolSpec[];
  hostToolDispatcher?: ManagedCodexHostToolDispatcher;
  components: ManagedCodexExtensionComponentResult[];
}

export interface ManagedCodexCommandExpansion {
  commandName: string;
  rawText: string;
  runtimeText: string;
  revision: string;
}
