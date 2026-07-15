import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import type { ToolUseSimple } from '@/types/chat';

import EditTool from './EditTool';
import { getToolSummaryNode } from './toolBadgeConfig';

function codexEditTool(): ToolUseSimple {
  return {
    id: 'call-file-change',
    name: 'Edit',
    input: {},
    streamIndex: 0,
    parsedInput: {
      file_path: '/tmp/a.md',
      changes: [
        {
          path: '/tmp/a.md',
          kind: { type: 'update', move_path: null },
          diff: '@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+extra',
        },
        {
          path: '/tmp/new.md',
          kind: { type: 'add' },
          diff: '---\ntitle: New\n---\n\nbody',
        },
      ],
    } as unknown as ToolUseSimple['parsedInput'],
    result: '[object Object]: /tmp/a.md\n@@ -1,2 +1,3 @@\n-old\n+new',
  };
}

describe('EditTool Codex fileChange rendering', () => {
  it('shows the base header while Edit input is still empty', () => {
    render(<EditTool tool={{
      id: 'call-empty-edit',
      name: 'Edit',
      input: {},
      streamIndex: 0,
    }} />);

    expect(screen.getByText('Edit')).toBeInTheDocument();
  });

  it('falls back to raw result when no file patch display can be resolved', () => {
    render(<EditTool tool={{
      id: 'call-raw-edit',
      name: 'Edit',
      input: {},
      streamIndex: 0,
      result: '[declined]\nFile changed',
      isError: true,
    }} />);

    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText((content) => content.includes('File changed'))).toBeInTheDocument();
  });

  it('uses changes[].diff for the summary chip', () => {
    const { container } = render(<>{getToolSummaryNode(codexEditTool())}</>);

    expect(container.textContent?.replace(/\s+/g, ' ').trim()).toBe('+7 -1');
  });

  it('uses inputJson as the summary source for restored history', () => {
    const { parsedInput: _parsedInput, ...tool } = codexEditTool();
    const restoredTool = {
      ...tool,
      inputJson: JSON.stringify({
        file_path: '/tmp/a.md',
        changes: [
          {
            path: '/tmp/a.md',
            kind: { type: 'update', move_path: null },
            diff: '@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+extra',
          },
        ],
      }),
    };

    const { container } = render(<>{getToolSummaryNode(restoredTool)}</>);

    expect(container.textContent?.replace(/\s+/g, ' ').trim()).toBe('+2 -1');
  });

  it('renders structured Codex diffs from persisted input when parsedInput is absent', () => {
    const { inputJson: _inputJson, parsedInput, ...tool } = codexEditTool();
    render(<EditTool tool={{ ...tool, input: parsedInput as Record<string, unknown> }} />);

    expect(screen.getByText('2 files')).toBeInTheDocument();
    expect(screen.getAllByText('/tmp/a.md').length).toBeGreaterThan(0);
    expect(screen.getByText((content) => content.includes('@@ -1,2 +1,3 @@'))).toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
  });

  it('renders structured Codex diffs instead of the raw [object Object] result', () => {
    render(<EditTool tool={codexEditTool()} />);

    expect(screen.getByText('2 files')).toBeInTheDocument();
    expect(screen.getAllByText('update')[0]).toBeInTheDocument();
    expect(screen.getByText('add')).toBeInTheDocument();
    expect(screen.getAllByText('/tmp/a.md').length).toBeGreaterThan(0);
    expect(screen.getAllByText('/tmp/new.md').length).toBeGreaterThan(0);
    expect(screen.getByText((content) => content.includes('@@ -1,2 +1,3 @@'))).toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
  });

  it('keeps non-completed patch status and move destination visible in structured diffs', () => {
    const tool: ToolUseSimple = {
      id: 'call-move',
      name: 'Edit',
      input: {
        file_path: '/tmp/old.md',
        changes: [
          {
            path: '/tmp/old.md',
            kind: { type: 'move', move_path: '/tmp/new.md' },
            diff: '@@ -1 +1 @@\n-old\n+new',
          },
        ],
      },
      streamIndex: 0,
      result: '[declined]\nmove: /tmp/old.md -> /tmp/new.md\n@@ -1 +1 @@\n-old\n+new',
      resultMeta: { status: 'declined' },
      isError: true,
    };

    render(<EditTool tool={tool} />);

    expect(screen.getByText('declined')).toBeInTheDocument();
    expect(screen.getAllByText('/tmp/old.md').length).toBeGreaterThan(0);
    expect(screen.getAllByText('/tmp/new.md').length).toBeGreaterThan(0);
    expect(screen.getAllByText('->').length).toBeGreaterThan(0);
  });
});

describe('tool summary input fallback', () => {
  it('uses neutral, localized singular and plural labels for input-only Write summaries', () => {
    const writeTool: ToolUseSimple = {
      id: 'call-write',
      name: 'Write',
      input: {},
      streamIndex: 0,
      inputJson: JSON.stringify({
        file_path: '/tmp/generated.md',
        content: 'one',
      }),
    };
    const en = i18n.getFixedT('en-US', 'chat');
    const zh = i18n.getFixedT('zh-CN', 'chat');
    const translateWith = (t: typeof en) => (key: string, options?: Record<string, unknown>) => (
      String(t(key, options))
    );

    const singular = render(<>{getToolSummaryNode(writeTool, translateWith(en))}</>);
    expect(singular.container.textContent?.trim()).toBe('Write 1 line');

    const pluralTool = {
      ...writeTool,
      inputJson: JSON.stringify({ file_path: '/tmp/generated.md', content: 'one\ntwo\nthree' }),
    };
    const plural = render(<>{getToolSummaryNode(pluralTool, translateWith(en))}</>);
    expect(plural.container.textContent?.trim()).toBe('Write 3 lines');

    const chinese = render(<>{getToolSummaryNode(pluralTool, translateWith(zh))}</>);
    expect(chinese.container.textContent?.trim()).toBe('写入 3 行');
  });
});
