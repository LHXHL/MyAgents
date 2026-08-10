import type {
  EffectiveProjectCapabilitySnapshot,
  ProjectCapabilityCandidate,
} from '../../shared/projectCapabilities';
import type { SlashCommand } from '../../shared/slashCommands';
import { isReservedSlashCommandName } from '../../shared/slashCommands';

export function findDisabledCapabilityForSlashInput(
  text: string,
  snapshot: EffectiveProjectCapabilitySnapshot,
): ProjectCapabilityCandidate | null {
  const match = /^\/([^\s]+)(?:\s|$)/.exec(text.trim());
  if (!match) return null;
  const name = match[1]!;
  if (isReservedSlashCommandName(name)) return null;
  return snapshot.candidates.find(item => (
    item.kind === 'command' && !item.enabled && item.canonicalName === name
  )) ?? null;
}

export function filterSlashCommandsForCapabilities(
  commands: SlashCommand[],
  snapshot: EffectiveProjectCapabilitySnapshot,
): SlashCommand[] {
  const disabledNames = new Set(
    snapshot.candidates
      .filter(item => item.kind === 'command' && !item.enabled)
      .map(item => item.canonicalName),
  );
  return commands.filter(command => (
    isReservedSlashCommandName(command.name) || !disabledNames.has(command.name)
  ));
}

export function buildBuiltinSkillAllowlist(
  snapshot: EffectiveProjectCapabilitySnapshot,
  pluginQualifiedSkillNames: Iterable<string>,
  unavailableSkillNames: Iterable<string> = [],
): string[] {
  const unavailable = new Set(unavailableSkillNames);
  return [...new Set([
    ...snapshot.enabledSkills
      .map(item => item.canonicalName)
      .filter(name => !unavailable.has(name)),
    ...pluginQualifiedSkillNames,
  ])].sort();
}
