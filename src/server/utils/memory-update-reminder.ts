export const MEMORY_UPDATE_COMPLETION_MARKER = 'MEMORY_UPDATE_OK';

export interface MemoryUpdateReminderInput {
  workspaceMemoryInstructions: string;
  currentTime: string;
}

/**
 * Build the hidden turn injected into the current Session by Memory Update.
 *
 * Keep the workspace instruction container even when its body is empty: an
 * empty body means “no workspace-specific additions”, while the official
 * system skill remains the workflow authority.
 */
export function buildMemoryUpdateReminder(input: MemoryUpdateReminderInput): string {
  return [
    '<system-reminder>',
    '<MEMORY_UPDATE>',
    '深度回顾当前 Session 的工作记忆，使用 `myagents-memory-update` skill，遵循记忆系统原则，将记忆沉淀到工作区内，让未来 Session 通过工作区仍然记得发生过的关键信息。',
    '',
    '以下是当前工作区自定义的维护要求：',
    '<workspace-memory-instructions>',
    input.workspaceMemoryInstructions,
    '</workspace-memory-instructions>',
    '',
    '只处理当前 Session 的工作记忆、相关工作区产物及其直接造成的修正。',
    '',
    `Current time: ${input.currentTime}`,
    '',
    `完成后仅回复 ${MEMORY_UPDATE_COMPLETION_MARKER}。`,
    '</MEMORY_UPDATE>',
    '</system-reminder>',
  ].join('\n');
}
