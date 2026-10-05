/**
 * Split one Markdown source into independently renderable top-level chunks.
 *
 * Why: ReactMarkdown parses its whole input synchronously on every change, so a
 * growing assistant text block re-parsed the entire prefix on each streaming
 * commit (O(n) per commit, O(n²) per block) and saturated the main thread in
 * long turns (#634). Rendering stable chunks as memoized siblings makes an
 * append re-parse only the tail chunk.
 *
 * Contract:
 * - Concatenating the chunks yields the input exactly.
 * - Prefix-stable: every split decision depends only on preceding lines and the
 *   completed line itself, so appending text never changes earlier chunks —
 *   except that a late document-scoped construct falls back to one chunk.
 * - Rendering the chunks as siblings produces the same document as rendering
 *   the whole source. Splits happen only before a column-0 line that follows a
 *   blank line outside fenced code / display math — a point where CommonMark
 *   has already closed every container — and never before list markers.
 *   Document-scoped constructs (reference/footnote definitions in any
 *   container, raw HTML tags/comments that may span paragraphs) disable
 *   splitting entirely: splitting is only an optimization, so ambiguity always
 *   resolves to whole-document rendering.
 */

/** Below this size per chunk the per-instance overhead outweighs the saving. */
export const MARKDOWN_CHUNK_MIN_CHARS = 2048;

// Opening fences per CommonMark / micromark-extension-math: a backtick or
// dollar info string cannot contain the fence character.
const CODE_FENCE_OPEN_RE = /^\s*(?:(`{3,})[^`]*|(~{3,}).*)$/;
const MATH_FENCE_OPEN_RE = /^\s*(\${2,})[^$]*$/;
const LIST_OR_CONTAINER_START_RE = /^(?:[-*+>]|\d{1,9}[.)])/;
// Any `[label]:` — inside blockquotes/lists or with a multi-line label too.
const DEFINITION_RE = /\[[^\]]+\]:/;
const HTML_RE = /<(?:\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>|[!?])/;

function hasDocumentScopedConstruct(source: string): boolean {
  if (DEFINITION_RE.test(source)) return true;
  if (!source.includes('<')) return false;
  // Raw HTML outside code is processed by rehype-raw across the whole tree;
  // an unclosed inline tag can affect later paragraphs. Code is inert text.
  const withoutCode = source
    .replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)/g, '')
    .replace(/`[^`\n]*`/g, '');
  return HTML_RE.test(withoutCode);
}

export function splitMarkdownRenderChunks(
  source: string,
  minChunkChars = MARKDOWN_CHUNK_MIN_CHARS,
): string[] {
  if (source.length < minChunkChars * 2 || hasDocumentScopedConstruct(source)) return [source];

  const chunks: string[] = [];
  let chunkStart = 0;
  let lineStart = 0;
  let fence: { char: string; length: number } | null = null;
  let previousBlank = false;

  while (lineStart < source.length) {
    const newline = source.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? source.length : newline;
    const line = source.slice(lineStart, lineEnd);

    if (
      fence === null
      // An unterminated last line may still become a list marker or fence.
      && newline >= 0
      && previousBlank
      && lineStart - chunkStart >= minChunkChars
      && line.length > 0
      && !/^\s/.test(line)
      && !LIST_OR_CONTAINER_START_RE.test(line)
    ) {
      chunks.push(source.slice(chunkStart, lineStart));
      chunkStart = lineStart;
    }

    if (fence) {
      const trimmed = line.trim();
      if (
        trimmed.length >= fence.length
        && trimmed === fence.char.repeat(trimmed.length)
      ) {
        fence = null;
      }
    } else {
      const open = CODE_FENCE_OPEN_RE.exec(line);
      const sequence = open ? open[1] ?? open[2] : MATH_FENCE_OPEN_RE.exec(line)?.[1];
      if (sequence) fence = { char: sequence[0], length: sequence.length };
    }

    previousBlank = line.trim().length === 0;
    if (newline < 0) break;
    lineStart = newline + 1;
  }

  chunks.push(source.slice(chunkStart));
  return chunks;
}
