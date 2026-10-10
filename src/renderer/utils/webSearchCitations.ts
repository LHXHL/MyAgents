import type { Message, ToolUseSimple } from '@/types/chat';
import type { CitationSource, CitationSources } from './runtimeCitations';

export function citationScope(message: Message): string {
  return message.turnId ? `turn:${message.turnId}` : `message:${message.id}`;
}

function parseSources(result?: string): [string, CitationSource][] {
  if (!result) return [];
  try {
    const parsed: unknown = JSON.parse(result);
    const rows = Array.isArray(parsed) ? parsed
      : parsed && typeof parsed === 'object' && 'results' in parsed && Array.isArray(parsed.results) ? parsed.results : [];
    return rows.flatMap((row: unknown) => {
      if (!row || typeof row !== 'object') return [];
      const value = row as Record<string, unknown>;
      if (typeof value.ref_id !== 'string' || typeof value.url !== 'string' || typeof value.title !== 'string') return [];
      return [[value.ref_id, { url: value.url, title: value.title }] as [string, CitationSource]];
    });
  } catch { return []; }
}

function sameSources(a: CitationSources | undefined, b: CitationSources): boolean {
  return a?.size === b.size && [...b].every(([id, source]) => {
    const old = a.get(id);
    return old === source || (old?.url === source?.url && old?.title === source?.title);
  });
}

/** A mounted list's derived index, never a source authority. Memoize immutable
 * tools and retain equal turn maps so text deltas don't invalidate history rows. */
export function createWebSearchCitationIndex() {
  const toolSources = new WeakMap<ToolUseSimple, [string, CitationSource][]>();
  let previous: ReadonlyMap<string, CitationSources> = new Map();
  return (messages: readonly Message[]): ReadonlyMap<string, CitationSources> => {
    const next = new Map<string, Map<string, CitationSource | null>>();
    for (const message of messages) {
      if (message.role !== 'assistant' || typeof message.content === 'string') continue;
      for (const block of message.content) {
        const tool = block.tool;
        if (!tool || tool.isError || !['WebSearch', 'web_search'].includes(tool.name)) continue;
        let sources = toolSources.get(tool);
        if (!sources) { sources = parseSources(tool.result); toolSources.set(tool, sources); }
        if (!sources.length) continue;
        const scope = citationScope(message);
        let map = next.get(scope);
        if (!map) { map = new Map(); next.set(scope, map); }
        for (const [id, source] of sources) {
          const old = map.get(id);
          // A conflicting ID never borrows a plausible URL from another call.
          map.set(id, !map.has(id) || (old?.url === source.url && old.title === source.title) ? source : null);
        }
      }
    }
    const stable = new Map<string, CitationSources>();
    for (const [scope, sources] of next) stable.set(scope, sameSources(previous.get(scope), sources) ? previous.get(scope)! : sources);
    if (stable.size !== previous.size || [...stable].some(([scope, sources]) => previous.get(scope) !== sources)) previous = stable;
    return previous;
  };
}
