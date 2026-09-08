import { describe, expect, it } from 'vitest';

import { parseCompatibleServerSearchContent } from './canonical-web-search-content';

describe('compatible server-search data content', () => {
  it.each(['', '  \n '])('uses provider content when snippet is blank (%#)', (snippet) => {
    expect(parseCompatibleServerSearchContent({ url: 'https://example.com', snippet, content: 'Source excerpt' }).results)
      .toEqual([{ url: 'https://example.com', snippet: 'Source excerpt' }]);
  });

  it('preserves a meaningful snippet over content', () => {
    expect(parseCompatibleServerSearchContent({ url: 'https://example.com', snippet: 'Summary', content: 'Full text' }).results)
      .toEqual([{ url: 'https://example.com', snippet: 'Summary' }]);
  });

  it('decodes a single-quoted data envelope and preserves escaped source strings', () => {
    expect(parseCompatibleServerSearchContent("[{'text': [{'title': 'Reader\\'s source', 'link': 'https://example.com', 'content': 'First\\nSecond'}]}]"))
      .toEqual({ results: [{ title: "Reader's source", url: 'https://example.com', snippet: 'First\nSecond' }], unverified: false, text: [] });
  });

  it('accepts explicit empty arrays as completed searches without hits', () => {
    expect(parseCompatibleServerSearchContent('[]')).toEqual({ results: [], unverified: false, text: [] });
    expect(parseCompatibleServerSearchContent("[{'text': []}]")).toEqual({ results: [], unverified: false, text: [] });
  });

  it('decodes concatenated result containers with quoted brackets and preserves a trailing unknown fragment', () => {
    expect(parseCompatibleServerSearchContent(
      "[{'text': [{'title': 'Source [one]', 'link': 'https://example.com/1'}]}]"
      + JSON.stringify([[{ title: 'Source two', link: 'https://example.com/2', content: 'A "]" in text' }]])
      + 'Unparsed trailing service text',
    )).toEqual({
      results: [
        { title: 'Source [one]', url: 'https://example.com/1', snippet: '' },
        { title: 'Source two', url: 'https://example.com/2', snippet: 'A "]" in text' },
      ],
      unverified: true, text: ['Unparsed trailing service text'],
    });
  });

  it.each([
    'Search found https://example.com',
    "[{'text': 'Opaque provider commentary'}]",
    "[{'text': [{'title': 'Missing URL'}]}]",
    "[{'text': [], 'sideEffect': (() => { throw Error('never execute') })()}]",
    '['.repeat(262145),
  ])('retains unknown data without evaluating it or inventing citations (%#)', (value) => {
    expect(parseCompatibleServerSearchContent(value)).toMatchObject({ results: [], unverified: true, text: [expect.any(String)] });
  });

  it.each(['results', 'search_result', 'search_results'])('accepts the %s envelope and preserves partial results', (field) => {
    expect(parseCompatibleServerSearchContent({ [field]: [
      { title: 'Source', url: 'https://example.com', content: {} },
      { text: 'Opaque service response' },
    ] })).toEqual({
      results: [{ title: 'Source', url: 'https://example.com', snippet: '' }],
      unverified: true, text: ['Opaque service response'],
    });
  });

  it.each([
    "[{'error': 'synthetic private provider message'}]",
    { type: 'web_search_tool_result_error', error_code: 'unavailable' },
    [{ url: 'https://example.com' }, { type: 'error', message: 'private service error' }],
  ])('keeps explicit service errors as sanitized failures (%#)', (value) => {
    expect(() => parseCompatibleServerSearchContent(value)).toThrow('Provider server-search tool failed');
  });
});
