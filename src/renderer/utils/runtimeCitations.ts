import type { Processor } from 'unified';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { Nodes, PhrasingContent, Parent, RootContent } from 'mdast';
import type { Tokenizer, State } from 'micromark-util-types';
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import { i18n } from '@/i18n';

export interface CitationSource { title: string; url: string }
export type CitationSources = ReadonlyMap<string, CitationSource | null>;
export interface CitationOptions { sources?: CitationSources; unavailableLabel?: string }

// A native citation is inline syntax, not a string replacement over Markdown:
// code, destinations and HTML attributes must remain literal. Tokenizing first
// also prevents source IDs containing underscores from becoming emphasis.
declare module 'micromark-util-types' {
  interface TokenTypeMap { runtimeCitation: 'runtimeCitation' }
}

interface RuntimeCitation extends Parent { type: 'runtimeCitation'; children: PhrasingContent[] }
declare module 'mdast' {
  interface PhrasingContentMap { runtimeCitation: RuntimeCitation }
  interface RootContentMap { runtimeCitation: RuntimeCitation }
}

const OPEN = '\uE200cite\uE202';
const CLOSE = 0xe201;

const tokenizeCitation: Tokenizer = (effects, ok, nok) => {
  let prefix = 0;
  return start;
  function start(code: number | null): State | undefined {
    effects.enter('runtimeCitation');
    return opening(code);
  }
  function opening(code: number | null): State | undefined {
    // A streamed partial opener is held back until its meaning is known.
    if (code === null) { effects.exit('runtimeCitation'); return ok(code); }
    if (code !== OPEN.charCodeAt(prefix)) return nok(code);
    effects.consume(code);
    return ++prefix === OPEN.length ? body : opening;
  }
  function body(code: number | null): State | undefined {
    if (code === null) { effects.exit('runtimeCitation'); return ok(code); }
    if (code === CLOSE) {
      effects.consume(code);
      effects.exit('runtimeCitation');
      return ok;
    }
    // Native source IDs and optional line locators use these characters.
    // A different construct cancels the attempt rather than swallowing prose.
    if (!(code === 0xe202 || code === 32 || code === -1 || code === -2 || /[A-Za-z0-9_-]/.test(String.fromCharCode(code)))) return nok(code);
    effects.consume(code);
    return body;
  }
};

function citationNodes(raw: string, options: CitationOptions): PhrasingContent[] {
  if (!raw.startsWith(OPEN)) return [];
  const label = options.unavailableLabel ?? String(i18n.t('app:markdown.citationUnavailable'));
  const unavailable: PhrasingContent = { type: 'text', value: `[${label}]` };
  if (!raw.endsWith(String.fromCharCode(CLOSE))) return [unavailable];
  const ids = raw.slice(OPEN.length, -1).split('\uE202').map(id => id.trim()).filter(Boolean);
  // A locator identifies a range within the last source; it isn't a source ID.
  if (ids.length > 1 && /^L\d+(?:-L\d+)?$/.test(ids.at(-1)!)) ids.pop();
  if (!ids.length) return [unavailable];
  const result: PhrasingContent[] = [];
  for (const id of new Set(ids)) {
    if (result.length) result.push({ type: 'text', value: ' ' });
    const candidate = options.sources?.get(id);
    let source: CitationSource | undefined;
    if (candidate?.title.trim()) {
      try {
        const url = new URL(candidate.url);
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) source = { ...candidate, url: url.href };
      } catch { /* unresolved source */ }
    }
    result.push(source
      ? { type: 'link', url: source.url, children: [{ type: 'text', value: `[${source.title}]` }] }
      : { type: 'text', value: `[${label}]` });
  }
  return result;
}

export function remarkRuntimeCitations(this: Processor, options: CitationOptions = {}) {
  const data = this.data();
  (data.micromarkExtensions ??= []).push({ text: { 0xe200: { name: 'runtimeCitation', tokenize: tokenizeCitation } } });
  const extension: FromMarkdownExtension = {
    enter: {
      runtimeCitation(token) { this.enter({ type: 'runtimeCitation', children: [] }, token); },
    },
    exit: {
      runtimeCitation(token) {
        const raw = this.sliceSerialize(token);
        const node = this.stack.at(-1);
        if (node?.type === 'runtimeCitation') {
          node.children = citationNodes(raw, options);
        }
        this.exit(token);
      },
    },
  };
  (data.fromMarkdownExtensions ??= []).push(extension);
  return (tree: Nodes) => {
    const visit = (node: Nodes) => {
      if (!('children' in node)) return;
      const parent = node as Parent;
      parent.children = parent.children.flatMap<RootContent>(child => {
        if (child.type === 'runtimeCitation') return child.children;
        visit(child);
        return [child];
      });
    };
    visit(tree);
  };
}

/** Copy/export only rewrite citation spans; source formatting and code stay exact. */
export function projectCitationMarkdown(source: string, options: CitationOptions = {}): string {
  if (!source.includes('\uE200')) return source;
  const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkRuntimeCitations, options);
  const tree = parser.parse(source);
  const edits: { start: number; end: number; value: string }[] = [];
  const visit = (node: Nodes) => {
    const citation = node.type === 'runtimeCitation' ? node.children : undefined;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (citation && start !== undefined && end !== undefined) {
      const value = citation.map(child => {
        if (child.type === 'text') return child.value;
        if (child.type !== 'link') return '';
        const title = (child.children[0] as { value: string }).value.slice(1, -1).replace(/\s+/g, ' ').replace(/[\\[\]]/g, '\\$&');
        return `[${title}](<${child.url.replace(/>/g, '%3E').replace(/</g, '%3C')}>)`;
      }).join('');
      edits.push({ start, end, value });
    }
    if ('children' in node) node.children.forEach(visit);
  };
  visit(tree);
  for (const edit of edits.reverse()) source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
  return source;
}
