import type { ComponentProps } from 'react';
import { defaultUrlTransform, type UrlTransform, type default as ReactMarkdown } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { fileUrlToPath } from './workspaceFileLinks';

/** Local references use the existing file scheme across the Markdown boundary.
 * Normalize drive spelling before sanitize, which otherwise sees C: as a scheme.
 * Micromark URL-encodes native backslashes; raw HTML keeps them literal. */
function normalizeMarkdownFileUrl(value: string): string | null {
  let candidate = value;
  if (/^[A-Za-z]:(?:[/\\]|%5c)/i.test(candidate)) {
    candidate = `file:///${candidate.replace(/%5c/ig, '/').replace(/\\/g, '/')}`;
  }
  if (!fileUrlToPath(candidate)) return null;
  return new URL(candidate).href;
}

interface MarkdownNode {
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownNode[];
}

function rehypeLocalFileReferences() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      const property = node.tagName === 'img' ? 'src' : node.tagName === 'a' ? 'href' : null;
      if (property && typeof node.properties?.[property] === 'string') {
        const normalized = normalizeMarkdownFileUrl(node.properties[property]);
        if (normalized) node.properties[property] = normalized;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

/** Only the application-owned image/link consumers may retain valid file URLs.
 * Other schemes/attributes still follow ReactMarkdown's default URL policy. */
export const MARKDOWN_URL_TRANSFORM: UrlTransform = (value, key, node) => {
  if (((key === 'src' && node.tagName === 'img') || (key === 'href' && node.tagName === 'a'))
    && fileUrlToPath(value)) return value;
  return defaultUrlTransform(value);
};

// Sanitize schema: allow safe HTML tags from rehype-raw, strip scripts/iframes/event handlers.
// Extends the default GitHub-flavored schema with additional tags used in AI-generated content.
export const MARKDOWN_SANITIZE_SCHEMA = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), 'file'],
    src: [...(defaultSchema.protocols?.src ?? []), 'file'],
  },
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    'details', 'summary',  // collapsible sections
    'mark', 'ins', 'del',  // text highlighting
    'sub', 'sup',           // subscript/superscript
    'kbd', 'var', 'samp',  // technical inline elements
  ],
  attributes: {
    ...defaultSchema.attributes,
    // Keep the default language-* class support for fenced code blocks.
    // Do not allow arbitrary class/style on raw HTML: AI/user Markdown can
    // otherwise render Tailwind or fixed-position overlay markup as live DOM.
    // KaTeX runs after this sanitizer, so its generated classes are unaffected.
    code: defaultSchema.attributes?.code ?? [],
  },
};

export const MARKDOWN_REMARK_PLUGINS_DEFAULT: ComponentProps<typeof ReactMarkdown>['remarkPlugins'] = [
  remarkGfm,
  remarkMath,
];

export const MARKDOWN_REMARK_PLUGINS_WITH_BREAKS: ComponentProps<typeof ReactMarkdown>['remarkPlugins'] = [
  remarkGfm,
  remarkMath,
  remarkBreaks,
];

export const MARKDOWN_REHYPE_PLUGINS: ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = [
  rehypeRaw,
  rehypeLocalFileReferences,
  [rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA],
  rehypeKatex,
];

/**
 * Convert YAML frontmatter (---\n...\n---) to a fenced yaml code block
 * so the existing CodeBlock component renders it with syntax highlighting.
 * Only applied in raw/file-preview mode where skill/agent .md files are displayed.
 */
export function convertFrontmatter(content: string): string {
  if (!content) return '';
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return content;
  const yamlBlock = '```yaml\n' + match[1] + '\n```\n';
  return yamlBlock + content.slice(match[0].length);
}
