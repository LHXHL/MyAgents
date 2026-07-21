import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { themeRegistry } from '@/theme';

import { THEME_PRESET_GROUPS, ThemePresetSelect } from './ThemePresetSelect';

describe('ThemePresetSelect', () => {
  it('keeps grouped selectable IDs exactly aligned with the accepted Registry catalog', () => {
    expect(THEME_PRESET_GROUPS.flatMap(group => [...group.ids])).toEqual(themeRegistry.getProductionIds());
  });

  it('renders accepted Themes in groups and persists only the selected Theme ID', async () => {
    const onPersistTheme = vi.fn().mockResolvedValue(undefined);
    render(
      <ThemePresetSelect
        value="myagents-default"
        onPersistTheme={onPersistTheme}
        onPersistError={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /MyAgents Default/ }));
    expect(screen.getByText('基准')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Default Black' })).toBeInTheDocument();
    expect(screen.getByText('原创')).toBeInTheDocument();
    expect(screen.getByText('社区 · PR #441')).toBeInTheDocument();
    expect(screen.getByText('参考')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(14);

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
