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

export const MEMORY_RULE_PATH_PLACEHOLDER = '{{MEMORY_RULE_PATH}}';
export const DEFAULT_MEMORY_RULE_RELATIVE_PATH = '.claude/rules/04-MEMORY.md';

export function renderDefaultUpdateMemoryContent(
  template: string,
  memoryRuleRelativePath: string = DEFAULT_MEMORY_RULE_RELATIVE_PATH,
): string {
  return template.replaceAll(MEMORY_RULE_PATH_PLACEHOLDER, memoryRuleRelativePath);
}
