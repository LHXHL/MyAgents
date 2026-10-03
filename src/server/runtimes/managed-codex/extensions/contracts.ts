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

export type ManagedCodexCommandSpec = import("../../product-extensions/contracts").ProductCommandSpec;
export type ManagedCodexSkillSpec = import("../../product-extensions/contracts").ProductSkillSpec;
export type ManagedCodexAgentRoleSpec = import("../../product-extensions/contracts").ProductAgentRoleSpec;

export type ManagedCodexDynamicToolSpec = ProductDynamicToolSpec;
export type ManagedCodexHostToolCall = ProductHostToolCall;
export type ManagedCodexHostToolContentItem = ProductHostToolContentItem;
export type ManagedCodexHostToolResult = ProductHostToolResult;
export type ManagedCodexHostToolDispatcher = ProductHostToolDispatcher;


export type ManagedCodexExtensionSnapshot = import("../../product-extensions/contracts").ProductExtensionSnapshot;
export type ManagedCodexCommandExpansion = import("../../product-extensions/contracts").ProductCommandExpansion;
