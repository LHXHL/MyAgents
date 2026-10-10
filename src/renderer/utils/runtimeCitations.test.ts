import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { describe, expect, it } from 'vitest';
import { MARKDOWN_REMARK_PLUGINS_DEFAULT, MARKDOWN_REHYPE_PLUGINS } from './markdownPipeline';
import { projectCitationMarkdown, remarkRuntimeCitations, type CitationOptions } from './runtimeCitations';

const marker = (id: string) => `\uE200cite\uE202${id}\uE201`;
const label = 'Source link unavailable';
function render(source: string, options: CitationOptions = {}): string {
  return renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: MARKDOWN_REMARK_PLUGINS_DEFAULT.map(plugin => plugin === remarkRuntimeCitations
      ? [remarkRuntimeCitations, { unavailableLabel: label, ...options }] as [typeof remarkRuntimeCitations, CitationOptions] : plugin),
    rehypePlugins: MARKDOWN_REHYPE_PLUGINS,
  }, source));
}

describe('native runtime citation presentation', () => {
  it('degrades all five exact persisted issue #651 markers without exposing controls or inventing links', () => {
    const ids = ['turn314133search1', 'turn629763search7', 'turn629763search10', 'turn314133search11', 'turn314133search0'];
    const html = render(ids.map(id => `Claim.${marker(id)}`).join('\n\n'));
    expect(html.match(/Source link unavailable/g)).toHaveLength(5);
    expect(html).not.toMatch(/[\uE200-\uE202]|turn\d+search|href=/);
  });

  it('resolves multiple explicit refs and file locators in prose and GFM tables', () => {
    const sources = new Map([
      ['turn0search0', { title: 'Primary <source>', url: 'https://example.com/a?x=1&y=2' }],
      ['turn0_file_1', { title: 'Other', url: 'https://example.org/' }],
    ]);
    const html = render(`Claim${marker('turn0search0\uE202turn0_file_1\uE202L8-L13')}\n\n| Claim | Source |\n| --- | --- |\n| Data | ${marker('turn0search0')} |`, { sources });
    expect(html).toContain('href="https://example.com/a?x=1&amp;y=2"');
    expect(html).toContain('href="https://example.org/"');
    expect(html).toContain('Primary &lt;source&gt;');
    expect(html).toContain('<table>');
    expect(html).not.toMatch(/[\uE200-\uE202]|L8-L13|turn0_file/);
  });

  it.each(['javascript:alert(1)', 'file:///tmp/a', 'https://user:secret@example.com/a', '//example.com/a', 'not a URL'])('refuses an unsafe mapped destination: %s', url => {
    const html = render(marker('turn0search0'), { sources: new Map([['turn0search0', { title: 'Unsafe', url }]]) });
    expect(html).toContain(label);
    expect(html).not.toContain('href=');
  });

  it.each(['', ' ', '\uE202', ' \uE202 '])('degrades a known citation opener with no source IDs (%j)', body => {
    const source = `Claim ${marker(body)} after.`;
    expect(render(source)).toBe(`<p>Claim [${label}] after.</p>`);
    expect(projectCitationMarkdown(source, { unavailableLabel: label })).toBe(`Claim [${label}] after.`);
  });

  it('never exposes any prefix of a split streamed citation', () => {
    const source = `Before ${marker('turn0search0')} after`;
    for (let end = 'Before '.length + 1; end <= source.length; end++) {
      const html = render(source.slice(0, end));
      expect(html).not.toMatch(/[\uE200-\uE202]|cite|turn0search/);
      expect(html).toContain('Before');
    }
    expect(render(source)).toContain(' after');
  });

  it('keeps code literals, unrelated controls and ordinary links untouched', () => {
    const cite = marker('turn0search0');
    for (const code of [`\`${cite}\``, `\`\`\`text\n${cite}\n\`\`\``, `~~~text\n${cite}\n~~~`, `    ${cite}`]) {
      expect(render(code)).toContain(cite);
      expect(projectCitationMarkdown(code)).toBe(code);
    }
    const normal = '[Source](https://example.com/) \uE200other\uE202literal\uE201 \uE777';
    expect(projectCitationMarkdown(normal)).toBe(normal);
    expect(render(normal)).toContain('\uE777');
  });

  it('projects only citation spans for copy/export, preserving all other Markdown bytes', () => {
    const source = `# Title\r\n\r\n**Claim** ${marker('turn0search0')}\r\n\r\n\`${marker('turn0search0')}\``;
    const options = { sources: new Map([['turn0search0', { title: 'A [title]', url: 'https://example.com/a(b)' }]]), unavailableLabel: label };
    const result = projectCitationMarkdown(source, options);
    expect(result).toBe(source.replace(marker('turn0search0'), '[A \\[title\\]](<https://example.com/a(b)>)'));
    expect(render(result)).toContain('href="https://example.com/a(b)"');
  });
});
