export interface MemoryRuleFileState {
  filename: string;
  relativePath: string;
  created: boolean;
}

export interface MemoryRuleSubstrateResult {
  soul: MemoryRuleFileState;
  user: MemoryRuleFileState;
  memory: MemoryRuleFileState;
}
