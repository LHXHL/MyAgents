import { describe, expect, it } from 'vitest';

import { splitMarkdownRenderChunks } from './markdownChunks';

const MIN = 64;

function section(i: number): string {
  return [
    `## Section ${i}`,
    '',
    `Paragraph ${i} with **bold** and \`code\`, plus enough words to pass the minimum chunk size.`,
    '',
    '- item one',
    '',
    '- item two (loose list continues across the blank line)',
    '',
    '  indented continuation of item two',
    '',
    '```ts',
    'const a = 1;',
    '',
    'notAHeading();',
    '```',
    '',
    '$$',
    'x = 1',
    '',
    'y = 2',
    '$$',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
  ].join('\n');
}

const doc = Array.from({ length: 12 }, (_, i) => section(i)).join('\n');

describe('splitMarkdownRenderChunks', () => {
  it('splits large documents losslessly', () => {
    const chunks = splitMarkdownRenderChunks(doc, MIN);
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks.join('')).toBe(doc);
  });

  it('only starts chunks at column-0 lines after a blank line, outside lists, fences and math', () => {
    const chunks = splitMarkdownRenderChunks(doc, MIN);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i - 1]).toMatch(/\n\s*\n$/);
      const firstLine = chunks[i].split('\n')[0];
      expect(firstLine).not.toMatch(/^\s/);
      expect(firstLine).not.toMatch(/^(?:[-*+>]|\d+[.)])/);
      expect(firstLine).not.toBe('notAHeading();');
      expect(firstLine).not.toBe('y = 2');
      const before = chunks.slice(0, i).join('');
      expect((before.match(/^```/gm) ?? []).length % 2).toBe(0);
      expect((before.match(/^\$\$$/gm) ?? []).length % 2).toBe(0);
    }
  });

  it('is prefix-stable while text streams in', () => {
    const final = splitMarkdownRenderChunks(doc, MIN);
    for (let end = 1; end <= doc.length; end += 37) {
      const partial = splitMarkdownRenderChunks(doc.slice(0, end), MIN);
      // Every chunk but the growing tail is already final.
      expect(partial.slice(0, -1)).toEqual(final.slice(0, partial.length - 1));
      expect(partial.join('')).toBe(doc.slice(0, end));
    }
  });

  it('does not decide a split on an unterminated line that may still become a list marker', () => {
    const P = `${'word '.repeat(20)}\n\n`;
    const before = splitMarkdownRenderChunks(`${P}${P}1`, MIN);
    const after = splitMarkdownRenderChunks(`${P}${P}1. item\n`, MIN);
    expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1));
  });

  it('keeps an unclosed streaming fence in the tail chunk', () => {
    const streaming = `${section(0)}${section(1)}\`\`\`\nopen fence\n\n# not a heading\n\nstill code`;
    const chunks = splitMarkdownRenderChunks(streaming, MIN);
    expect(chunks.at(-1)).toContain('```\nopen fence\n\n# not a heading\n\nstill code');
  });

  it('does not split documents with document-scoped definitions or raw HTML', () => {
    expect(splitMarkdownRenderChunks(`${doc}\n[ref]: https://example.com\n`, MIN)).toHaveLength(1);
    expect(splitMarkdownRenderChunks(`${doc}\n[^1]: footnote\n`, MIN)).toHaveLength(1);
    expect(splitMarkdownRenderChunks(`<details>\n\n${doc}\n\n</details>`, MIN)).toHaveLength(1);
    expect(splitMarkdownRenderChunks(`${doc}\ntext <b>bold\n\nmore</b>\n`, MIN)).toHaveLength(1);
  });

  it('ignores tags that only appear inside code', () => {
    const withCodeTags = `${doc}\nUse \`<div>\` here.\n\n\`\`\`html\n<span>x</span>\n\`\`\`\n`;
    expect(splitMarkdownRenderChunks(withCodeTags, MIN).length).toBeGreaterThan(1);
  });

  it('leaves small documents whole', () => {
    expect(splitMarkdownRenderChunks('# Title\n\nShort text.')).toEqual(['# Title\n\nShort text.']);
  });
});
