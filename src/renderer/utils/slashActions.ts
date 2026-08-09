// Client-action slash commands
// ----------------------------------------------------------------------------
// Most slash commands either insert text into the input (and get sent to the
// AI, e.g. `/compact`) or are disk-backed skills/commands discovered by the
// Rust scanner. A *client-action* command is different: selecting it triggers
// a renderer-side UI action (e.g. arming the Goal composer draft) and is never
// sent to the AI.
//
// Such a command's behavior lives entirely in the renderer, so it is also
// *defined* and *injected* in the renderer (not registered in the Rust builtin
// list). It is only surfaced when the host wires an `onSlashAction` handler to
// service it — so it can never appear as a dead entry whose action can't run.
// This keeps the command and its action coupled by construction.

import type { SlashCommand } from '../../shared/slashCommands';
import { i18n } from '@/i18n';

/** Built-in slash commands whose selection dispatches a renderer-side action. */
export const CLIENT_ACTION_SLASH_COMMANDS: SlashCommand[] = [
  { name: 'goal', description: 'Run toward a goal continuously', source: 'builtin', aliases: ['loop'] },
];

const CLIENT_ACTION_ALIAS_TARGETS = new Map<string, string>([
  ['loop', 'goal'],
]);

const CLIENT_ACTION_VISIBLE_NAMES = new Set(CLIENT_ACTION_SLASH_COMMANDS.map((cmd) => cmd.name));
const CLIENT_ACTION_NAMES = new Set([
  ...CLIENT_ACTION_VISIBLE_NAMES,
  ...CLIENT_ACTION_ALIAS_TARGETS.keys(),
]);

function getClientActionSlashCommands(): SlashCommand[] {
  return CLIENT_ACTION_SLASH_COMMANDS.map((cmd) => ({
    ...cmd,
    description: String(i18n.t(`chat:input.slashCommands.${cmd.name}`, { defaultValue: cmd.description })),
  }));
}

export function resolveClientActionName(rawName: string): string | null {
  const name = rawName.trim().replace(/^\/+/, '').toLowerCase();
  if (!CLIENT_ACTION_NAMES.has(name)) return null;
  return CLIENT_ACTION_ALIAS_TARGETS.get(name) ?? name;
}

/** Whether selecting `cmd` should dispatch a client action instead of inserting text. */
export function isClientActionCommand(cmd: SlashCommand): boolean {
  return cmd.source === 'builtin' && resolveClientActionName(cmd.name) !== null;
}

/** Reserved command names — a disk-backed skill/command may not shadow these. */
const RESERVED_NAMES = new Set(CLIENT_ACTION_NAMES);

/**
 * Merge client-action commands into a fetched slash-command list.
 *
 * - `enabled` is false (no `onSlashAction` handler) → returns the list
 *   untouched so the command never appears where its action can't run.
 * - Client-action names are **reserved**: the product command preempts any
 *   same-named disk-backed skill/command. Without this, a user skill literally
 *   named `goal` would shadow `/goal` (its `source` is 'skill', so the dispatch
 *   would insert text instead of opening the panel) — a silent failure of a
 *   first-class command, and incoherent with ranking builtins first. Reserving
 *   guarantees `/goal` and its `/loop` alias always resolve to their action.
 */
export function withClientActionCommands(commands: SlashCommand[], enabled: boolean): SlashCommand[] {
  if (!enabled) return commands;
  const kept = commands.filter((c) => !RESERVED_NAMES.has(c.name));
  return [...kept, ...getClientActionSlashCommands()];
}
