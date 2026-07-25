import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSettingsNavigation } from './hooks/useSettingsNavigation';

function Probe(props: {
  initialSection?: string;
  navigationNonce?: number;
  floatingBallDevGate?: boolean;
  onSectionChange?: () => void;
}) {
  const { activeSection } = useSettingsNavigation(props);
  return <div data-testid="section">{activeSection}</div>;
}

describe('useSettingsNavigation', () => {
  it('opens a valid deep-linked section and notifies the host to clear the one-shot target', async () => {
    const onSectionChange = vi.fn();
    render(<Probe initialSection="mcp" floatingBallDevGate onSectionChange={onSectionChange} />);

    await waitFor(() => expect(screen.getByTestId('section')).toHaveTextContent('mcp'));
    expect(onSectionChange).toHaveBeenCalledTimes(1);
  });

  it('opens desktop-pet when the feature gate is omitted because the tab defaults on', async () => {
    const onSectionChange = vi.fn();
    render(<Probe initialSection="desktop-pet" onSectionChange={onSectionChange} />);

    await waitFor(() => expect(screen.getByTestId('section')).toHaveTextContent('desktop-pet'));
    expect(onSectionChange).toHaveBeenCalledTimes(1);
  });

  it('falls back from desktop-pet when the feature gate is explicitly off', async () => {
    const onSectionChange = vi.fn();
    render(<Probe initialSection="desktop-pet" floatingBallDevGate={false} onSectionChange={onSectionChange} />);

    await waitFor(() => expect(screen.getByTestId('section')).toHaveTextContent('about'));
    expect(onSectionChange).toHaveBeenCalledTimes(1);
  });

  it('re-applies the same deep link when a new navigation intent arrives', async () => {
    const onSectionChange = vi.fn();
    const { rerender } = render(
      <Probe initialSection="skills" navigationNonce={1} onSectionChange={onSectionChange} />,
    );

    await waitFor(() => expect(onSectionChange).toHaveBeenCalledTimes(1));
    rerender(<Probe initialSection="skills" navigationNonce={2} onSectionChange={onSectionChange} />);

    await waitFor(() => expect(onSectionChange).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('section')).toHaveTextContent('skills');
  });
});
