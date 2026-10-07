/**
 * Preprocess markdown content for better streaming compatibility.
 *
 * Markdown Priority (highest to lowest):
 * 1. Code blocks (``` ```) - content is literal, no parsing
 * 2. Inline code (` `) - content is literal, no parsing
 * 3. Everything else (headers, lists, emphasis, etc.)
 *
 * This function respects the priority by:
 * 1. Extracting and protecting code blocks and inline code
 * 2. Applying format fixes to the remaining content
 * 3. Restoring the protected code
 */
export function preprocessMarkdownContent(content: string): string {
  if (!content) return '';

  // Step 1: Extract and protect code blocks and inline code
  const protected_: string[] = [];
  let processed = content;

  // Protect fenced code blocks (``` ... ```)
  processed = processed.replace(/```[\s\S]*?```/g, (match) => {
    protected_.push(match);
    return `\x00CODE${protected_.length - 1}\x00`;
  });

  // Protect inline code (` ... `) - handle both single and multiple backticks
  processed = processed.replace(/`[^`]+`/g, (match) => {
    protected_.push(match);
    return `\x00CODE${protected_.length - 1}\x00`;
  });

  // Protect GFM table blocks (2+ consecutive lines starting with |)
  // Keep table source protected while applying prose-format fixes.
  processed = processed.replace(/(?:^[ \t]*\|[^\n]*(?:\n|$)){2,}/gm, (match) => {
    protected_.push(match);
    return `\x00CODE${protected_.length - 1}\x00`;
  });

  // Step 2: Apply format fixes to unprotected content

  // 2a-pre. Normalize full-width punctuation that Chinese-tuned models
  // (DeepSeek, MiniMax, Qwen, GLM, …) emit in place of ASCII markdown markers.
  // CommonMark only recognizes ASCII `*`, `_`, `~`, `#` etc. — when a model
  // outputs `＊＊P1＊＊` (U+FF0A) instead of `**P1**`, the bold renders as
  // literal full-width asterisks (issue #167). We only convert *paired*
  // patterns so an isolated full-width char in legitimate Chinese text
  // (e.g., a name with `＊` for redaction) stays untouched.
  // - `＊＊...＊＊` → `**...**` (bold)
  // - `＊...＊` → `*...*` (italic — applied after bold so triple-stars work)
  // - `＿＿...＿＿` → `__...__` (alt bold)
  // - `～～...～～` → `~~...~~` (GFM strikethrough)
  processed = processed.replace(/＊＊([^＊\n]+?)＊＊/g, '**$1**');
  processed = processed.replace(/＊([^＊\n]+?)＊/g, '*$1*');
  processed = processed.replace(/＿＿([^＿\n]+?)＿＿/g, '__$1__');
  processed = processed.replace(/～～([^～\n]+?)～～/g, '~~$1~~');

  // 2a. Escape currency dollar signs ($100, $3,000, $1.50 etc.)
  // remark-math treats $...$ as inline LaTeX, causing false positives like
  // "$3000 亿...$1880 亿" being rendered as a math expression.
  // Pattern: $ followed by digit, not preceded by another $ (preserves $$...$$)
  processed = processed.replace(/(?<!\$)\$(?=\d)/g, '\\$');

  // Preserve heading source boundaries. Inserting newlines before an inline
  // `# ` manufactures a heading and can break escapes, links, indented code,
  // blockquotes and lists. Adding spaces to `#tag` has the same ambiguity.
  // Let CommonMark decide headings from the author's original line structure.

  // 2d. Fix unordered list items at LINE START ONLY
  // "-item" -> "- item". Exclude digits so negative-leading values like
  // "-50% drop" at line start don't get rewritten into a list item.
  processed = processed.replace(/^-([^\s\-\n\d])/gm, '- $1');

  // 2e. Fix ordered list items at LINE START ONLY
  // "1.item" -> "1. item". Exclude digits so version numbers / dates /
  // IPs like "0.2.18", "2026.5.18", "192.168.1.1" at line start don't get
  // rewritten into an ordered list (which then swallows the rest of the line).
  processed = processed.replace(/^(\d+\.)([^\s\n\d])/gm, '$1 $2');

  // Step 3: Restore protected code blocks and inline code
  // Multiple passes needed: table blocks may contain inline code placeholders,
  // so restoring the table in one pass leaves inner placeholders unresolved.
  // eslint-disable-next-line no-control-regex -- Intentional use of NUL as placeholder
  while (/\x00CODE\d+\x00/.test(processed)) {
    // eslint-disable-next-line no-control-regex
    processed = processed.replace(/\x00CODE(\d+)\x00/g, (_, index) => {
      return protected_[parseInt(index, 10)];
    });
  }

  return processed;
}
