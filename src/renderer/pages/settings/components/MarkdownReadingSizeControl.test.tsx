import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MarkdownReadingSizeControl } from './MarkdownReadingSizeControl';

describe('MarkdownReadingSizeControl', () => {
  it('shows the selected reading preset and sends the new choice', () => {
    const onChange = vi.fn();
    render(<MarkdownReadingSizeControl value="large" onChange={onChange} />);

    expect(screen.getByText('Markdown 阅读字号')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '大字号' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['标准字号', '大字号']);
    const standard = screen.getByRole('button', { name: '标准字号' });
    expect(standard).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(standard);
    expect(onChange).toHaveBeenCalledWith('standard');
  });
});
