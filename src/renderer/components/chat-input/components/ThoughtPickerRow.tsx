import type { Thought } from "@/../shared/types/thought";
import { useTranslation } from "react-i18next";
import { isSupportedLocale } from "@/../shared/i18n";
import {
  findHighlightRanges,
  renderTextWithHighlights,
} from "@/utils/highlightSearchMatches";
import { formatPastRelativeTime } from "@/i18n/format";

interface ThoughtPickerRowProps {
  thought: Thought;
  query: string;
}

export function ThoughtPickerRow({ thought, query }: ThoughtPickerRowProps) {
  const { i18n } = useTranslation();
  const locale = isSupportedLocale(i18n.language) ? i18n.language : "zh-CN";
  const ranges =
    query.trim().length > 0 ? findHighlightRanges(thought.content, query) : [];
  const tags = (thought.tags ?? []).slice(0, 3);

  return (
    <div
      title={thought.content}
      className="flex min-w-0 items-center gap-2 px-3 py-2"
    >
      <span className="shrink-0 text-xs text-[var(--ink-muted)]">
        {formatPastRelativeTime(thought.updatedAt, locale)}
      </span>
      {tags.length > 0 && (
        <span className="flex max-w-[35%] shrink-0 items-center gap-1 overflow-hidden">
          {tags.map((t) => (
            <span
              key={t}
              className="min-w-0 truncate rounded-[var(--radius-sm)] bg-[var(--accent-warm-subtle)] px-1.5 py-px text-xs text-[var(--accent-warm)]"
            >
              #{t}
            </span>
          ))}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-sm text-[var(--ink-secondary)]">
        {ranges.length > 0
          ? renderTextWithHighlights(thought.content, ranges)
          : thought.content}
      </span>
    </div>
  );
}
