import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ThemeRuntimeProvider } from '@/theme/ThemeRuntime';

const probe = vi.hoisted(() => ({ parsedChars: 0, chunking: true }));

vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-markdown')>();
  const Counted = (props: Parameters<typeof actual.default>[0]) => {
    probe.parsedChars += typeof props.children === 'string' ? props.children.length : 0;
    return actual.default(props);
  };
  return { ...actual, default: Counted };
});

vi.mock('@/utils/markdownChunks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/markdownChunks')>();
  return {
    ...actual,
    splitMarkdownRenderChunks: (source: string) => (probe.chunking ? actual.splitMarkdownRenderChunks(source) : [source]),
  };
});

import Markdown from './Markdown';

function Theme({ children }: { children: ReactNode }) {
  return <ThemeRuntimeProvider selection={{ themeId: 'myagents-default', appearanceMode: 'light' }} persistBootstrapSnapshot={false}>{children}</ThemeRuntimeProvider>;
}

function report(sections: number): string {
  return Array.from({ length: sections }, (_, i) => [
    `## Finding ${i}`,
    '',
    `The command output for step ${i} is summarized here with **emphasis**, \`inline\` code and a [link](https://example.com/${i}).`,
    '',
    '1. first',
    '2. second',
    '',
    '```json',
    JSON.stringify({ step: i, ok: true, values: [1, 2, 3] }, null, 2),
    '```',
    '',
    '| key | value |',
    '| --- | ----- |',
    `| step | ${i} |`,
    '',
    '> quoted note',
    '',
  ].join('\n')).join('\n');
}

afterEach(() => {
  probe.chunking = true;
  probe.parsedChars = 0;
});

describe('Markdown chunked rendering (#634)', () => {
  it('produces the same DOM as one whole-document parse', () => {
    const doc = report(40);
    probe.chunking = false;
    const whole = render(<Theme><Markdown>{doc}</Markdown></Theme>).container.innerHTML;
    probe.chunking = true;
    const chunked = render(<Theme><Markdown>{doc}</Markdown></Theme>).container.innerHTML;
    expect(chunked).toBe(whole);
  });

  // Shapes whose meaning spans blank lines (review reproductions). Each must
  // render identically whole vs chunked, whether or not it is split.
  const P = `${'paragraph '.repeat(230)}\n\n`;
  it.each([
    ['multi-line HTML comment', `${P}<!-- secret\n\n${P}SHOULD STAY HIDDEN\n\n-->\n\nVisible`],
    ['definition inside a blockquote', `${P}[visible][ref]\n\n${P}another\n\n${P}> [ref]: https://example.com\n`],
    ['footnote definition in a list', `${P}See[^n].\n\n${P}- [^n]: note\n`],
    ['multi-line reference label', `${P}[a\nb][]\n\n${P}[a\nb]: https://example.com\n`],
    ['four-dollar display math with blank lines', `${P}$$$$\na=1\n\n${P}b=2\n$$$$\n\nend`],
    ['backtick info string is not a fence', `${P}\`\`\`x\`\`\` is inline\n\n\`\`\`\ncode\n\n${P}more code\n\`\`\`\n\nafter`],
    ['loose list then column-0 paragraph', `${P}- a\n\n- b\n\n  continued\n\n${P}Paragraph after list\n\n${P}`],
    ['tilde fence with blank lines', `${P}~~~\nx\n\n${P}~~~\n\nafter\n\n${P}`],
  ])('keeps %s equivalent', (_name, doc) => {
    for (const raw of [false, true]) {
      probe.chunking = false;
      const whole = render(<Theme><Markdown raw={raw}>{doc}</Markdown></Theme>).container.innerHTML;
      probe.chunking = true;
      const chunked = render(<Theme><Markdown raw={raw}>{doc}</Markdown></Theme>).container.innerHTML;
      expect(chunked).toBe(whole);
    }
  });

  it('re-parses only the growing tail when streaming text is appended', () => {
    const doc = report(60);
    const view = render(<Theme><Markdown streaming>{doc}</Markdown></Theme>);
    probe.parsedChars = 0;
    view.rerender(<Theme><Markdown streaming>{`${doc}More streamed words`}</Markdown></Theme>);
    expect(probe.parsedChars).toBeGreaterThan(0);
    expect(probe.parsedChars).toBeLessThan(doc.length / 10);
  });

  it('keeps the streaming tail fade on the last chunk only', () => {
    const { container } = render(<Theme><Markdown streaming>{report(30)}</Markdown></Theme>);
    expect(container.querySelectorAll('.md-stream-tail')).toHaveLength(1);
  });
});
