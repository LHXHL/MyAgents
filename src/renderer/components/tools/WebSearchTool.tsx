import { useState } from 'react';
import { Globe, ExternalLink as ExternalLinkIcon, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ToolUseSimple, WebSearchInput } from '@/types/chat';
import ExternalLink from '@/components/ExternalLink';
import { ExpandableResult } from './utils';

const COLLAPSED_COUNT = 5;

interface WebSearchToolProps {
  tool: ToolUseSimple;
}

interface SearchResult {
  title: string;
  url: string;
}

function parseSearchPresentation(resultStr: string): {
  results: SearchResult[];
  text: string;
  unverified: boolean;
  domainUnverified: boolean;
  completedEmpty: boolean;
} {
  const results: SearchResult[] = [];
  const text: string[] = [];
  const seen = new Set<string>();
  const addResult = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const item = value as Record<string, unknown>;
    if (typeof item.title !== 'string' || typeof item.url !== 'string' || seen.has(item.url)) return;
    try {
      const url = new URL(item.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    } catch { return; }
    seen.add(item.url);
    results.push({ title: item.title, url: item.url });
  };
  try {
    const parsed: unknown = JSON.parse(resultStr);
    const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : {};
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(record.results) ? record.results : undefined;
    if (typeof record.answer === 'string' && record.answer) text.push(record.answer);
    for (const item of rows ?? []) {
      if (typeof item === 'string') { text.push(item); continue; }
      addResult(item);
      if (item && typeof item === 'object' && Array.isArray(item.content)) {
        for (const child of item.content) addResult(child);
      }
    }
    const unverified = Array.isArray(record.warnings) && record.warnings.includes('unverified_search_results');
    const domainUnverified = Array.isArray(record.warnings) && record.warnings.includes('unverified_domain_filter');
    return {
      results, text: text.join('\n\n') || (rows === undefined ? resultStr : ''),
      unverified, domainUnverified, completedEmpty: rows !== undefined && results.length === 0 && !unverified,
    };
  } catch {
    return { results, text: resultStr, unverified: false, domainUnverified: false, completedEmpty: false };
  }
}

export default function WebSearchTool({ tool }: WebSearchToolProps) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  const input = tool.parsedInput as WebSearchInput;
  const presentation = tool.result ? parseSearchPresentation(tool.result) : undefined;
  const results = presentation?.results ?? [];

  if (!input && !tool.inputJson) {
    return <div className="text-sm text-[var(--ink-muted)]">{t('shell.toolChrome.webSearch.initializing')}</div>;
  }

  let query = input?.query || '';
  if (!query && tool.inputJson) {
    try {
      query = JSON.parse(tool.inputJson).query || '';
    } catch {
      // Invalid JSON, use empty string
    }
  }
  const hasMore = results.length > COLLAPSED_COUNT;
  const visibleResults = expanded ? results : results.slice(0, COLLAPSED_COUNT);
  const hiddenCount = results.length - COLLAPSED_COUNT;

  return (
    <div className="flex flex-col gap-3 font-sans text-sm">
      {/* Search Results */}
      {results.length > 0 && (
        <div className="flex flex-col">
          {visibleResults.map((item) => (
            <ExternalLink
              key={item.url}
              href={item.url}
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--paper-inset)] [&:hover_.result-title]:text-[var(--accent)] [&:hover_.result-icon]:opacity-100"
            >
              {/* Globe icon */}
              <Globe className="size-4 shrink-0 text-[var(--ink-muted)]" />

              {/* Title */}
              <span className="result-title flex-1 truncate text-[var(--ink)] transition-colors">
                {item.title}
              </span>

              {/* External link indicator */}
              <ExternalLinkIcon className="result-icon size-3 shrink-0 text-[var(--ink-muted)] opacity-0 transition-opacity" />
            </ExternalLink>
          ))}

          {/* Expand button */}
          {hasMore && !expanded && (
            <button
              onClick={() => setExpanded(true)}
              className="flex items-center gap-1 px-2 py-1 text-xs text-[var(--ink-muted)] hover:text-[var(--ink)] transition-colors"
            >
              <ChevronDown className="size-3" />
              <span>{t('shell.toolChrome.webSearch.expandRemaining', { count: hiddenCount })}</span>
            </button>
          )}
        </div>
      )}

      {presentation?.unverified && (
        <div className="text-sm text-[var(--ink-muted)]">
          {t(presentation.domainUnverified
            ? 'shell.toolChrome.webSearch.unverifiedDomainText'
            : 'shell.toolChrome.webSearch.unverifiedText')}
        </div>
      )}
      {presentation?.completedEmpty && !presentation.text && (
        <div className="text-sm text-[var(--ink-muted)]">{t('shell.toolChrome.webSearch.noMatches')}</div>
      )}
      {presentation?.text && (
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]">{t('shell.toolChrome.webSearch.toolOutput')}</div>
          <ExpandableResult
            content={presentation.text}
            className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper-inset)] p-3 text-xs text-[var(--ink-secondary)]"
          />
        </div>
      )}

      {/* Loading state if no result yet */}
      {!tool.result && tool.isLoading && (
        <div className="flex items-center gap-2 text-xs text-[var(--ink-muted)] animate-pulse">
          <Globe className="size-3" />
          <span>{t('shell.toolChrome.webSearch.searchingFor', { query })}</span>
        </div>
      )}
    </div>
  );
}
