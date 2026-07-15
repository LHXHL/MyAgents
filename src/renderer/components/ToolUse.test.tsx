import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ToolUseSimple } from '@/types/chat';

import ToolUse from './ToolUse';

describe('ToolUse specialized result ownership', () => {
  it('passes a large Bash result intact to the terminal transcript budget', () => {
    const result = Array.from(
      { length: 5_001 },
      (_, index) => `line-${index}-${'x'.repeat(20)}`,
    ).join('\n');
    expect(result.length).toBeGreaterThan(50_000);
    const tool: ToolUseSimple = {
      id: 'large-bash',
      name: 'Bash',
      input: { command: 'generate-output' },
      streamIndex: 0,
      result,
      resultMeta: { status: 'completed', exitCode: 0 },
    };
    const { container } = render(<ToolUse tool={tool} />);

    expect(container).not.toHaveTextContent('结果过长，已截断');
    expect(screen.getByRole('button', { name: '展示全部' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '展示全部' }));

    expect(container).toHaveTextContent('line-4998');
    expect(container).not.toHaveTextContent('line-5000');
    expect(screen.getByRole('status')).toHaveTextContent('终端内容过长');
  });

  it('does not corrupt a large SDK wrapper before Bash separates stderr', () => {
    const result = JSON.stringify({
      stdout: 'x'.repeat(210_000),
      stderr: 'warning from stderr',
      interrupted: false,
    });
    expect(result.length).toBeGreaterThan(200_000);
    const { container } = render(<ToolUse tool={{
      id: 'large-sdk-bash',
      name: 'Bash',
      input: { command: 'generate-output' },
      streamIndex: 0,
      result,
      resultMeta: { status: 'completed', exitCode: 0 },
    }} />);

    expect(container.querySelector('[data-bash-stream="stdout"]')).toBeInTheDocument();
    expect(container.querySelector('[data-bash-stream="stderr"]')).toHaveTextContent('warning from stderr');
    expect(container.querySelector('[data-bash-stream="combined"]')).not.toBeInTheDocument();
  });
});
