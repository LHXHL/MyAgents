import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithTheme } from '@/test/renderWithTheme';

import Markdown from './Markdown';

describe('Markdown source heading boundaries', () => {
  it.each([
    ['句中 # 只是符号', '句中 # 只是符号'],
    ['结果：## 仍然是正文', '结果：## 仍然是正文'],
    [String.raw`正文 \# 转义符号`, '正文 # 转义符号'],
    ['#标签', '#标签'],
    ['####### 非标题', '####### 非标题'],
  ])('does not manufacture a heading from %s', (source, expected) => {
    const { container } = render(<Markdown>{source}</Markdown>);

    expect(container.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
    expect(container.querySelector('p')?.textContent).toBe(expected);
  });

  it('preserves inline hashes in Markdown link labels', () => {
    const { container } = render(<Markdown>{'[请看 # 这一条](https://example.com)'}</Markdown>);

    expect(container.querySelector('a')?.textContent).toBe('请看 # 这一条');
    expect(container.querySelector('h1')).toBeNull();
  });

  it('preserves indented code containing hashes', () => {
    const { container } = renderWithTheme(<Markdown>{'正文\n\n    ## code\n    second line'}</Markdown>);

    expect(container.querySelector('pre code')?.textContent).toContain('## code');
    expect(container.querySelector('h2')).toBeNull();
  });

  it('preserves headings inside blockquotes and lists', () => {
    const { container } = render(<Markdown>{'> ## 引用标题\n\n- ### 列表标题'}</Markdown>);

    expect(container.querySelector('blockquote h2')?.textContent).toBe('引用标题');
    expect(container.querySelector('li h3')?.textContent).toBe('列表标题');
  });

  it('keeps standard Setext headings in raw document previews', () => {
    const { container } = render(<Markdown raw>{'一级标题\n===\n\n二级标题\n---'}</Markdown>);

    expect(container.querySelector('h1')?.textContent).toBe('一级标题');
    expect(container.querySelector('h2')?.textContent).toBe('二级标题');
  });
});

describe('Markdown explicit-heading parser scope', () => {
  it('keeps equals underlines as text instead of implicit H1 headings', () => {
    const { container } = render(<Markdown preserveNewlines allowSetextHeadings={false}>{'正文\n==='}</Markdown>);

    expect(container.querySelector('h1')).toBeNull();
    expect(container.querySelector('p')?.textContent).toBe('正文\n===');
    expect(container.querySelector('hr')).toBeNull();
  });

  it.each(['```', '~~~'])('keeps separators and hashes literal in %s fenced code', fence => {
    const source = `${fence}text\n---\n# literal\n${fence}`;
    const { container } = renderWithTheme(<Markdown preserveNewlines allowSetextHeadings={false}>{source}</Markdown>);

    expect(container.querySelector('pre code')?.textContent).toContain('---\n# literal');
    expect(container.querySelector('hr, h1')).toBeNull();
  });

  it('preserves GFM table delimiter rows and hash-containing cells', () => {
    const source = '项目 | 状态\n--- | ---\n任务 | # 普通符号';
    const { container } = render(<Markdown allowSetextHeadings={false}>{source}</Markdown>);

    expect(container.querySelector('table')).not.toBeNull();
    expect([...container.querySelectorAll('td')].map(node => node.textContent)).toEqual(['任务', '# 普通符号']);
    expect(container.querySelector('hr, h1, h2')).toBeNull();
  });

  it('preserves quoted and list separators without promoting their paragraphs', () => {
    const source = '> 引用正文\n> ---\n> 引用后续\n\n- 列表正文\n  ---\n  列表后续';
    const { container } = render(<Markdown preserveNewlines allowSetextHeadings={false}>{source}</Markdown>);

    expect(container.querySelector('blockquote hr')).not.toBeNull();
    expect(container.querySelector('li hr')).not.toBeNull();
    expect(container.querySelector('h1, h2')).toBeNull();
  });

  it('isolates parser settings between instances and restores defaults on rerender', () => {
    const source = '正文\n---';
    const { container, rerender } = render(<>
      <Markdown allowSetextHeadings={false}>{source}</Markdown>
      <Markdown raw>{source}</Markdown>
    </>);
    const roots = container.querySelectorAll('.markdown-content');

    expect(roots[0].querySelector('hr')).not.toBeNull();
    expect(roots[0].querySelector('h2')).toBeNull();
    expect(roots[1].querySelector('h2')?.textContent).toBe('正文');

    rerender(<Markdown>{source}</Markdown>);
    expect(container.querySelector('h2')?.textContent).toBe('正文');
    expect(container.querySelector('hr')).toBeNull();
  });
});
