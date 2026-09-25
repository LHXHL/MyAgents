import type { RuntimeSource, RuntimeType } from '../../shared/types/runtime';

import myagentsIcon from '@/assets/runtime-icons/myagents.png';
import claudeCodeIcon from '@/assets/runtime-icons/claude-code.png';
import codexIcon from '@/assets/runtime-icons/codex.png';

export const RUNTIME_PRESENTATION: Record<RuntimeType, { name: string; icon: string }> = {
  builtin: { name: 'MyAgents (Claude Agent SDK)', icon: myagentsIcon },
  dsh: { name: 'MyAgents (DeepSeek Harness)', icon: myagentsIcon },
  'claude-code': { name: 'Claude Code CLI', icon: claudeCodeIcon },
  codex: { name: 'Codex CLI', icon: codexIcon },
};

/** Managed Codex and the user's Codex CLI share a runtime type, but not an owner. */
export function sessionRuntimePresentation(
  runtime: RuntimeType,
  source?: RuntimeSource | null,
): { name: string; icon: string } {
  if (runtime === 'codex' && source === 'managed-provider') {
    return { ...RUNTIME_PRESENTATION.codex, name: 'Managed Codex' };
  }
  return RUNTIME_PRESENTATION[runtime];
}
