import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import McpToolsCard from './McpToolsCard';

describe('McpToolsCard', () => {
  it('supports read-only Session views while retaining the existing editable Agent card', () => {
    const toggle = vi.fn();
    const props = { availableMcpServers: [{ id: 'tool', name: 'Shared tool' }], enabledServerIds: ['tool'], onToggle: toggle };
    const { rerender } = render(<McpToolsCard {...props} disabled />);
    expect(screen.getByRole('checkbox', { name: 'Shared tool' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Shared tool' })).toBeDisabled();
    rerender(<McpToolsCard {...props} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Shared tool' }));
    expect(toggle).toHaveBeenCalledWith('tool');
  });
});
