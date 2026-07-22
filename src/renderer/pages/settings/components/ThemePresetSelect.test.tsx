import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { themeRegistry } from '@/theme';

import { ThemePresetSelect } from './ThemePresetSelect';

describe('ThemePresetSelect', () => {
  it('renders every accepted Theme in one flat list and persists only the selected Theme ID', async () => {
    const onPersistTheme = vi.fn().mockResolvedValue(undefined);
    render(
      <ThemePresetSelect
        value="myagents-default"
        onPersistTheme={onPersistTheme}
        onPersistError={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /MyAgents Default/ }));
    expect(screen.getByRole('button', { name: 'Default Black' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sage' })).toBeInTheDocument();
    expect(screen.queryByText('基准')).not.toBeInTheDocument();
    expect(screen.queryByText('社区 · PR #441')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(themeRegistry.getProductionIds().length + 1);

    const defaultBlackOption = screen.getByRole('button', { name: 'Default Black' });
    const swatchGroup = defaultBlackOption.querySelector('[aria-hidden="true"]');
    expect(swatchGroup).not.toBeNull();
    expect(swatchGroup?.children).toHaveLength(2);
    expect(swatchGroup?.children[0]).toHaveStyle({ backgroundColor: '#111111' });
    expect(within(defaultBlackOption).getByText('Default Black')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Raycast' }));
    });
    expect(onPersistTheme).toHaveBeenCalledWith('raycast');
  });

  it('does not display an optimistic value and reports persistence failures', async () => {
    const failure = new Error('disk unavailable');
    const onPersistError = vi.fn();
    render(
      <ThemePresetSelect
        value="myagents-default"
        onPersistTheme={vi.fn().mockRejectedValue(failure)}
        onPersistError={onPersistError}
      />,
    );

    const trigger = screen.getByRole('button', { name: /MyAgents Default/ });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Linear' }));

    expect(trigger).toHaveTextContent('MyAgents Default');
    await waitFor(() => expect(onPersistError).toHaveBeenCalledWith(failure));
    expect(trigger).toHaveTextContent('MyAgents Default');
  });
});
